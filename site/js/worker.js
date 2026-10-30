/* Runs many simulations off the main thread and returns sorted per-player distributions. */
importScripts("sim.js");
let model = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.model) model = m.model;
  if (!m.run) return;
  const agg = NBASim.simulateMany(model, m.opts, m.n, (p) => self.postMessage({ progress: p }));
  self.postMessage({ done: true, result: NBASim.summarize(agg) });
};
