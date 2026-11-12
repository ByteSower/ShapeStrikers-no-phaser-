/**
 * Lets players drag floating UI (chat button, dev tools) and remembers where they left it.
 * A press that moves less than the threshold still counts as a normal click.
 */
const Draggable = (() => {
  const KEY_PREFIX = 'shape_strikers_ui_pos_';
  const DRAG_THRESHOLD = 6;      // px of movement before a press becomes a drag
  const CLICK_SUPPRESS_MS = 80;  // swallow only the click produced by releasing a drag
  const items = [];

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  /**
   * A position is the screen corner an element is docked to plus its offset
   * from that corner, so it grows away from the nearest edges when it opens.
   */
  function positionFromRect(rect, handleCenter, viewport) {
    const h = handleCenter.x < viewport.width / 2 ? 'left' : 'right';
    const v = handleCenter.y < viewport.height / 2 ? 'top' : 'bottom';
    return {
      h,
      v,
      x: Math.round(h === 'left' ? rect.left : viewport.width - rect.right),
      y: Math.round(v === 'top' ? rect.top : viewport.height - rect.bottom),
    };
  }

  /** Offsets that keep an element of `size` fully inside the viewport. */
  function clampPosition(pos, size, viewport) {
    return {
      ...pos,
      x: clamp(pos.x, 0, viewport.width - size.width),
      y: clamp(pos.y, 0, viewport.height - size.height),
    };
  }

  function _viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function _load(name) {
    try {
      const pos = JSON.parse(localStorage.getItem(KEY_PREFIX + name));
      const valid = pos && (pos.h === 'left' || pos.h === 'right') && (pos.v === 'top' || pos.v === 'bottom')
        && Number.isFinite(pos.x) && Number.isFinite(pos.y);
      return valid ? pos : null;
    } catch (error) {
      return null;
    }
  }

  function _fitted(item) {
    return clampPosition(item.pos, { width: item.el.offsetWidth, height: item.el.offsetHeight }, _viewport());
  }

  function _apply(item) {
    if (!item.pos) return; // never moved: keep the stylesheet position
    const pos = _fitted(item);
    const style = item.el.style;
    style.transform = 'none';
    style.left = pos.h === 'left' ? pos.x + 'px' : 'auto';
    style.right = pos.h === 'right' ? pos.x + 'px' : 'auto';
    style.top = pos.v === 'top' ? pos.y + 'px' : 'auto';
    style.bottom = pos.v === 'bottom' ? pos.y + 'px' : 'auto';
    item.el.dataset.dockH = pos.h;
    item.el.dataset.dockV = pos.v;
  }

  /** Make `el` draggable by `handle`; `name` keys the saved position. */
  function attach(el, handle, name) {
    if (!el || !handle) return;
    const item = { el, handle, pos: _load(name) };
    items.push(item);
    handle.classList.add('drag-handle');
    _apply(item);
    // Re-fit when the element opens or closes so it never hangs off-screen.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => _apply(item)).observe(el);

    let suppressClickUntil = 0;
    handle.addEventListener('click', event => {
      if (window.performance.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const elRect = el.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      let dragging = false;

      const onMove = moveEvent => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          dragging = true;
          el.classList.add('is-dragging');
          try { handle.setPointerCapture(event.pointerId); } catch (error) { /* pointer already released */ }
        }
        item.pos = positionFromRect(
          { left: elRect.left + dx, right: elRect.right + dx, top: elRect.top + dy, bottom: elRect.bottom + dy },
          { x: handleRect.left + handleRect.width / 2 + dx, y: handleRect.top + handleRect.height / 2 + dy },
          _viewport()
        );
        _apply(item);
      };

      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        if (!dragging) return;
        el.classList.remove('is-dragging');
        item.pos = _fitted(item);
        localStorage.setItem(KEY_PREFIX + name, JSON.stringify(item.pos));
        suppressClickUntil = window.performance.now() + CLICK_SUPPRESS_MS;
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    });
  }

  window.addEventListener('resize', () => items.forEach(_apply));

  return { attach, positionFromRect, clampPosition };
})();
