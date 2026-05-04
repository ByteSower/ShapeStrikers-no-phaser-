'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AUDIO_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/audio.js'), 'utf8');

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

class FakeAudio {
  static instances = [];
  static playBehaviors = [];
  static playCalls = [];

  static reset() {
    FakeAudio.instances = [];
    FakeAudio.playBehaviors = [];
    FakeAudio.playCalls = [];
  }

  constructor(src = '') {
    this.src = src;
    this.loop = false;
    this.volume = 1;
    this.currentTime = 0;
    this.preload = '';
    this.playsInline = false;
    this.listeners = new Map();
    this.pauseCount = 0;
    this.loadCount = 0;
    this.attributes = new Map();
    FakeAudio.instances.push(this);
  }

  cloneNode() {
    return new FakeAudio(this.src);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  load() {
    this.loadCount += 1;
  }

  pause() {
    this.pauseCount += 1;
  }

  play() {
    FakeAudio.playCalls.push(this.src);
    const behavior = FakeAudio.playBehaviors.shift() || 'resolve';
    if (behavior === 'reject') {
      return Promise.reject(new Error('blocked'));
    }
    return Promise.resolve();
  }
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name) {
      for (const listener of listeners.get(name) || []) listener();
    },
    getListeners(name) {
      return listeners.get(name) || [];
    },
  };
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function loadAudioContext() {
  FakeAudio.reset();
  const documentTarget = createEventTarget();
  const windowTarget = createEventTarget();

  const context = {
    console,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    localStorage: createStorage(),
    document: documentTarget,
    window: {
      Audio: FakeAudio,
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
    },
  };

  context.global = context;
  vm.createContext(context);
  vm.runInContext(AUDIO_SOURCE, context, { filename: 'audio.js' });

  return {
    Audio: vm.runInContext('Audio', context),
    documentTarget,
  };
}

console.log('\nAudio manager tests\n');

async function run() {
  await test('Blocked music retries on the next user gesture', async () => {
    const { Audio, documentTarget } = loadAudioContext();
    FakeAudio.playBehaviors.push('reject', 'resolve');

    Audio.init();
    Audio.playMusic('ss_title_music_full.wav');
    await flushMicrotasks();

    assert.deepEqual(FakeAudio.playCalls, ['public/Audio/ss_title_music_full.wav']);

    documentTarget.emit('pointerdown');
    await flushMicrotasks();

    assert.deepEqual(FakeAudio.playCalls, [
      'public/Audio/ss_title_music_full.wav',
      'public/Audio/ss_title_music_full.wav',
    ]);
  });

  await test('Blocked retriable cues are deduped until the next user gesture', async () => {
    const { Audio, documentTarget } = loadAudioContext();
    FakeAudio.playBehaviors.push('reject', 'reject', 'resolve');

    Audio.init();
    Audio.play('getReady');
    Audio.play('getReady');
    await flushMicrotasks();

    assert.deepEqual(
      FakeAudio.playCalls.filter((src) => src === 'public/Audio/get_ready.wav'),
      ['public/Audio/get_ready.wav', 'public/Audio/get_ready.wav']
    );

    documentTarget.emit('click');
    await flushMicrotasks();

    assert.deepEqual(
      FakeAudio.playCalls.filter((src) => src === 'public/Audio/get_ready.wav'),
      ['public/Audio/get_ready.wav', 'public/Audio/get_ready.wav', 'public/Audio/get_ready.wav']
    );
  });

  await test('Muting pauses active SFX clones', async () => {
    const { Audio } = loadAudioContext();
    FakeAudio.playBehaviors.push('resolve');

    Audio.init();
    Audio.play('objective');
    await flushMicrotasks();

    const playingClone = FakeAudio.instances.filter((audio) => audio.src === 'public/Audio/objective_complete.wav').at(-1);
    assert.ok(playingClone, 'Expected an active SFX clone instance');
    assert.equal(playingClone.pauseCount, 0);

    assert.equal(Audio.toggleMute(), true);
    assert.equal(playingClone.pauseCount, 1);
    assert.equal(Audio.isMuted(), true);
  });
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});