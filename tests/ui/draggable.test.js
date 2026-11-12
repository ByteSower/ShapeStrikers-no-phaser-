'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = { addEventListener() {}, innerWidth: 400, innerHeight: 800 };
global.localStorage = { getItem: () => null, setItem() {} };

const sourcePath = path.resolve(__dirname, '../../src/draggable.js');
vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });

const viewport = { width: 400, height: 800 };

test('positions dock to the corner nearest the handle', () => {
  const rect = { left: 20, right: 70, top: 700, bottom: 740 };

  assert.deepEqual(Draggable.positionFromRect(rect, { x: 45, y: 720 }, viewport), { h: 'left', v: 'bottom', x: 20, y: 60 });
  assert.deepEqual(
    Draggable.positionFromRect({ left: 300, right: 380, top: 10, bottom: 40 }, { x: 340, y: 25 }, viewport),
    { h: 'right', v: 'top', x: 20, y: 10 }
  );
});

test('positions are clamped so the element stays fully on screen', () => {
  const size = { width: 280, height: 360 };

  assert.deepEqual(
    Draggable.clampPosition({ h: 'left', v: 'bottom', x: 300, y: 700 }, size, viewport),
    { h: 'left', v: 'bottom', x: 120, y: 440 }
  );
  assert.deepEqual(
    Draggable.clampPosition({ h: 'right', v: 'top', x: -30, y: -5 }, size, viewport),
    { h: 'right', v: 'top', x: 0, y: 0 }
  );
});

test('elements larger than the viewport pin to their docked corner', () => {
  assert.deepEqual(
    Draggable.clampPosition({ h: 'left', v: 'top', x: 50, y: 50 }, { width: 500, height: 900 }, viewport),
    { h: 'left', v: 'top', x: 0, y: 0 }
  );
});
