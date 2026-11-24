'use strict';

const { platformOf } = require('./priceRequests');

const missing = value => value == null || (typeof value === 'string' && !value.trim());
const hasSize = value => typeof value === 'string' && !!value.trim();
const identity = (portal, id) => hasSize(portal)
  && ((typeof id === 'string' && !!id.trim()) || (typeof id === 'number' && Number.isFinite(id)))
  ? JSON.stringify([portal, String(id)]) : null;

// Fill display-only metadata without replacing a request's recorded truck shape or prices.
function planDimensionRefresh(records, sources) {
  if (!Array.isArray(records) || !Array.isArray(sources)) throw new TypeError('records and sources must be arrays');
  const lookup = new Map();
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const key = identity(source.platformKey, source.id);
    if (key) lookup.set(key, lookup.has(key) ? null : source);
  }
  const changes = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || !hasSize(record.id) || !record.load || typeof record.load !== 'object') continue;
    const portal = record.platformKey == null ? platformOf(record) : record.platformKey;
    const source = lookup.get(identity(portal, record.loadId));
    if (!source) continue;
    const load = record.load;
    const types = Array.isArray(load.cargoTypes) ? load.cargoTypes : [];
    let afterLoad;
    if (types.length > 1) {
      const sourceTypes = source.cargoTypes;
      if (!Array.isArray(sourceTypes) || sourceTypes.length !== types.length) continue;
      const byMatch = new Map();
      let valid = true;
      for (const type of sourceTypes) {
        if (!type || !hasSize(type.match) || !hasSize(type.label) || !Number.isInteger(type.count)
          || type.count <= 0 || byMatch.has(type.match)) { valid = false; break; }
        byMatch.set(type.match, type);
      }
      const seen = new Set();
      const filled = [];
      let changed = false;
      for (const type of types) {
        if (!valid || !type || !hasSize(type.match) || !hasSize(type.label) || !Number.isInteger(type.count)
          || type.count <= 0 || seen.has(type.match)) { valid = false; break; }
        seen.add(type.match);
        const current = byMatch.get(type.match);
        if (!current || current.label !== type.label || current.count !== type.count) { valid = false; break; }
        if (missing(type.dimensions) && hasSize(current.dimensions)) {
          filled.push({ ...type, dimensions: current.dimensions });
          changed = true;
        } else filled.push(type);
      }
      if (!valid || !changed) continue;
      afterLoad = { ...load, cargoTypes: filled };
    } else {
      if (!missing(load.dimensions) || !hasSize(source.dimensions) || !hasSize(load.equipment)
        || load.equipment !== source.equipment) continue;
      afterLoad = { ...load, dimensions: source.dimensions };
    }
    changes.push({ id: record.id, loadId: record.loadId, platformKey: portal, beforeLoad: load, afterLoad });
  }
  return changes;
}

module.exports = { planDimensionRefresh };
