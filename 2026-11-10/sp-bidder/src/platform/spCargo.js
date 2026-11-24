'use strict';

function ownsSpDetail(detail, loadId) {
  const data = detail && (detail.data || detail);
  if (!data || loadId == null || !String(loadId).trim()) return false;
  const ids = [data.loads && data.loads.id, data.loadDetails && data.loadDetails.loadId]
    .filter(id => id != null);
  return ids.length > 0 && ids.every(id => String(id) === String(loadId));
}

// The carrier drawer renders this server-formatted field; listing/master tuples have no such contract.
function readSpDimensions(detail, loadId) {
  if (!ownsSpDetail(detail, loadId)) return null;
  const data = detail.data || detail;
  const rows = data.loadReference && data.loadReference.infoToShow;
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(row => row && row.title === 'Dimensions');
  if (matches.length !== 1 || typeof matches[0].value !== 'string') return null;
  const value = matches[0].value;
  if (/^(?:\s*|n\/?a|[-:]+)$/i.test(value.trim())) return null;
  const numbers = value.match(/\d+(?:\.\d+)?/g);
  if (numbers && (numbers.every(n => Number(n) === 0)
    || (numbers.length === 3 && numbers.some(n => Number(n) === 0)))) return null;
  return value;
}

module.exports = { readSpDimensions, ownsSpDetail };
