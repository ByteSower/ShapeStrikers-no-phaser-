'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/game.js'), 'utf8');
const layoutSource = source.slice(source.indexOf('  function _positionTutorialBox('),
  source.indexOf('  function _nextTutorialStep('));

function harness(width, height, boxHeight, initialRect) {
  const overlay = { hidden: false, classList: { contains: () => overlay.hidden } };
  const box = { style: {}, dataset: { position: 'right' }, offsetHeight: boxHeight };
  let rect = initialRect;
  const context = vm.createContext({
    window: { innerWidth: width, innerHeight: height },
    document: {
      getElementById: id => id === 'tutorial-box' ? box : overlay,
      querySelector: () => ({ getBoundingClientRect: () => rect }),
    },
  });
  vm.runInContext(layoutSource, context);
  return {
    box, overlay, context,
    moveTarget: next => { rect = next; },
    position: side => context._positionTutorialBox(box, rect, side),
  };
}

test('tutorial uses measured height and an available side rather than covering its target', () => {
  const layout = harness(600, 480, 250, { left: 20, right: 580, top: 300, bottom: 400, width: 560 });
  layout.position('right');
  assert.equal(layout.box.style.top, '38px');
  assert.equal(layout.box.style.left, '100px');
});

test('repositioning remeasures the tutorial without advancing its step', () => {
  const layout = harness(1280, 900, 200, { left: 200, right: 600, top: 100, bottom: 500, width: 400 });
  layout.position('right');
  assert.equal(layout.box.style.left, '612px');
  layout.context.window.innerWidth = 800;
  layout.context.window.innerHeight = 600;
  layout.moveTarget({ left: 100, right: 600, top: 220, bottom: 550, width: 500 });
  layout.context._repositionTutorialBox();
  assert.equal(layout.box.style.top, '8px');
  assert.equal(layout.box.style.left, '150px');
  layout.moveTarget({ left: 100, right: 600, top: 250, bottom: 550, width: 500 });
  layout.context._repositionTutorialBox();
  assert.equal(layout.box.style.top, '38px');
  assert.equal(layout.box.dataset.position, 'right');
});

test('tutorial clamps both axes when no side fits and stays hidden after dismissal', () => {
  const layout = harness(360, 480, 300, { left: 0, right: 360, top: -50, bottom: 600, width: 360 });
  layout.position('bottom');
  assert.equal(layout.box.style.width, '344px');
  assert.equal(layout.box.style.left, '8px');
  assert.equal(layout.box.style.top, '172px');
  layout.overlay.hidden = true;
  layout.moveTarget({ left: 0, right: 360, top: 0, bottom: 10, width: 360 });
  layout.context._repositionTutorialBox();
  assert.equal(layout.box.style.top, '172px');
});
