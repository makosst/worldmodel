// Catalog text shown to the agent. The catalog itself is the per-prompt subset of the
// model library chosen by selectModels() in library.js.
export function catalogText(catalog) {
  return Object.values(catalog)
    .map((m) => `- ${m.name}: ${m.description}. Size at scale 1: ${m.size[0]}m wide (x) × ${m.size[2]}m deep (z) × ${m.size[1]}m tall`)
    .join('\n');
}
