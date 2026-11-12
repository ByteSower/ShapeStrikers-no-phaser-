/**
 * Optional WebGL renderer for grid effects: one full-area fragment shader per effect.
 * Uses the browser's built-in WebGL, so it adds no dependency.
 */
const GridFxGl = (() => {
  const MAX_DPR = 1.5;
  const VERTEX = 'attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }';
  const HEADER = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec2 u_res;    // canvas size in device px
    uniform float u_dpr;
    uniform float u_time;  // seconds
    uniform vec4 u_rect;   // grid x, y, width, height in CSS px from the top-left

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
      return v;
    }
    float roundedBox(vec2 p, vec2 halfSize, float r) {
      vec2 q = abs(p) - halfSize + r;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }
  `;

  const SHADERS = {
    ice: `
      float snowLayer(vec2 p, float cell, float fall, float drift, float seed) {
        vec2 q = vec2(p.x - drift, p.y - u_time * fall);
        q.x += sin(q.y * 0.012 + seed * 3.0) * cell * 0.35;
        vec2 g = q / cell;
        vec2 id = floor(g) + seed;
        vec2 f = fract(g) - 0.5;
        float h = hash(id);
        vec2 offset = vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5;
        float r = mix(0.035, 0.085, h);
        return smoothstep(r, r * 0.25, length(f - offset * 0.7)) * step(0.4, h);
      }

      void main() {
        vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_dpr;
        vec2 size = u_res / u_dpr;
        float t = u_time;
        // Wind speed is 40 + 50*sin(0.45t) px/s; this is its integral, so gusts never jump.
        float wind = 40.0 * t - 111.0 * cos(t * 0.45);
        float gust = 0.5 + 0.5 * sin(t * 0.45);

        float d = roundedBox(p - (u_rect.xy + u_rect.zw * 0.5), u_rect.zw * 0.5, 18.0);
        float inside = smoothstep(4.0, -10.0, d);

        float snow = 0.0;
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          snow += snowLayer(p, 26.0 + 9.0 * fi, 30.0 + 24.0 * fi, wind * (0.5 + 0.25 * fi), fi * 11.7)
                  * (0.35 + 0.2 * fi);
        }
        snow = min(snow, 1.0) * mix(1.0, 0.55, inside); // keep units readable

        float streak = noise(vec2((p.x - wind * 5.0) * 0.006, p.y * 0.09 + 3.0));
        streak = smoothstep(0.72, 0.95, streak) * (0.15 + 0.85 * gust) * 0.22 * mix(1.0, 0.4, inside);

        float mist = fbm(vec2((p.x - wind * 0.6) * 0.005, p.y * 0.008 + t * 0.03));
        mist = smoothstep(0.35, 0.9, mist) * 0.3 * (1.0 - inside) * mix(0.45, 1.0, p.y / size.y);

        float crystals = fbm(p * 0.07) + noise(p * 0.35) * 0.25;
        float frost = smoothstep(42.0, 0.0, d) * smoothstep(-2.0, 2.0, d)
                      * smoothstep(0.35, 0.75, crystals - d / 90.0) * 0.6;
        frost += smoothstep(-16.0, 0.0, d) * (1.0 - smoothstep(0.0, 2.0, d))
                 * smoothstep(0.5, 0.85, crystals) * 0.35;

        float glow = exp(-abs(d) / 10.0) * 0.45 * (0.85 + 0.15 * sin(t * 1.3));

        vec2 cell = floor(p / 5.0);
        float sparkle = step(0.975, hash(cell)) * (0.5 + 0.5 * sin(t * 4.0 + hash(cell + 1.0) * 40.0))
                        * smoothstep(34.0, 0.0, abs(d)) * smoothstep(0.42, 0.05, length(fract(p / 5.0) - 0.5));

        vec3 ice = vec3(0.62, 0.86, 1.0);
        vec3 color = vec3(snow) + ice * (streak + frost) + vec3(0.8, 0.9, 1.0) * mist
                     + vec3(0.55, 0.85, 1.0) * glow + vec3(sparkle);
        float alpha = clamp(snow + streak + mist + frost + glow * 0.8 + sparkle, 0.0, 1.0);
        gl_FragColor = vec4(min(color, vec3(1.0)), alpha);
      }
    `,
  };

  function _compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    console.warn('[GridFxGl] Shader failed to compile:', gl.getShaderInfoLog(shader));
    return null;
  }

  /**
   * Start an effect over the grid area. Returns a stop function, or null when
   * the effect has no shader or WebGL is unavailable. `onLost` runs if the GPU
   * context is lost while the effect is running.
   */
  function start(name, area, container, onLost) {
    if (!SHADERS[name]) return null;
    const canvas = document.createElement('canvas');
    canvas.className = 'grid-fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'low-power' });
    if (!gl) return null;

    const vertex = _compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = _compile(gl, gl.FRAGMENT_SHADER, HEADER + SHADERS[name]);
    const program = gl.createProgram();
    if (!vertex || !fragment) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[GridFxGl] Program failed to link:', gl.getProgramInfoLog(program));
      return null;
    }
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'u_res');
    const uDpr = gl.getUniformLocation(program, 'u_dpr');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uRect = gl.getUniformLocation(program, 'u_rect');

    canvas.style.left = canvas.style.top = '0';
    area.appendChild(canvas);

    let frameId = 0;
    let stopped = false;
    let clock = 0;
    let lastTime = window.performance.now();

    function frame(now) {
      frameId = window.requestAnimationFrame(frame);
      clock += Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      if (!container.offsetWidth) return; // game screen hidden

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const width = Math.round(area.clientWidth * dpr);
      const height = Math.round(area.clientHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = area.clientWidth + 'px';
        canvas.style.height = area.clientHeight + 'px';
        gl.viewport(0, 0, width, height);
      }
      gl.uniform2f(uRes, width, height);
      gl.uniform1f(uDpr, dpr);
      gl.uniform1f(uTime, clock);
      gl.uniform4f(uRect, container.offsetLeft, container.offsetTop, container.offsetWidth, container.offsetHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      window.cancelAnimationFrame(frameId);
      canvas.remove();
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    canvas.addEventListener('webglcontextlost', () => {
      if (stopped) return;
      stop();
      onLost();
    });

    frameId = window.requestAnimationFrame(frame);
    return stop;
  }

  return { start };
})();
