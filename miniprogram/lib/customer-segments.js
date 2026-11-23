const SEGMENTS = [
  { id: 'new', label: '新客', rule: '到店 1 次', minVisits: 1 },
  { id: 'potential', label: '可发展客', rule: '到店 2–3 次', minVisits: 2 },
  { id: 'vvip', label: 'VVIP', rule: '到店 4 次及以上', minVisits: 4 },
]

function segmentForVisits(visits) {
  for (let index = SEGMENTS.length - 1; index >= 0; index--) {
    const segment = SEGMENTS[index]
    if (visits >= segment.minVisits) return segment
  }
  return null
}

module.exports = { SEGMENTS, segmentForVisits }
