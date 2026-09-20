import { createRofGame } from './game.js';
import { SEED_SHAPES, shapePreview } from './dough.js';
import { estimateRise } from './riseModel.js';
import * as portions from './portions.js';

// renderer.js is a classic script and can't `import`, so the game module registers itself on
// window. Every instance is tracked so leaving the Recipe on Fire screen can tear its WebGL
// context down (browsers cap live contexts, and an orphaned one keeps its GPU memory).
const instances = new Set();

window.RofGame = {
  shapes: SEED_SHAPES, // the four seed dough shapes (name, real size, unit weight)
  estimateRise,        // deterministic rise / browning model from ingredient rows
  portions,            // portion arithmetic: whole portions from grams, leftover, defaults
  shapePreview,        // outline + slash lines of a shape spec, for the Shapes modal preview
  create(container, opts) {
    const game = createRofGame(container, opts);
    instances.add(game);
    const dispose = game.dispose;
    game.dispose = () => { instances.delete(game); dispose(); };
    return game;
  },
  disposeAll() { [...instances].forEach(g => g.dispose()); },
  current() { return [...instances][0] || null; }, // debugging / tests
};
window.dispatchEvent(new Event('rof-game-ready'));
