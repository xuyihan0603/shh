const hallNames = ['厅1', '厅2', '厅3', '厅5']
const floors = [
  ['一楼', [
    ['101', 10, 10], ['103', 4, 6], ['105', 6, 8], ['卡1', 4, 4],
    ...hallNames.map(name => [name, null, null]),
  ]],
  ['二楼', [
    ['201', 10, 12], ['202', 4, 4], ['203', 12, 14], ['205', 8, 10],
    ['206', 8, 10], ['207', 10, 12], ['208', 10, 12], ['209', 10, 12],
    ['210', 8, 10], ['211', 8, 10], ['阳光房B1', 14, 16],
  ]],
  ['三楼', [
    ['301', 8, 8], ['302', 6, 6], ['303', 8, 8], ['305', 6, 6],
    ['306', 8, 8], ['307', 10, 10], ['308', 10, 10], ['309', 4, 6], ['310', 4, 6],
  ]],
]

const pilotTables = floors.flatMap(([floor, seats]) => seats.map(([name, minCapacity, capacity]) => ({
  id: name, name, floor, type: name === '卡1' || hallNames.includes(name) ? 'hall' : 'room', minCapacity, capacity,
})))
const pilotTableIds = new Set(pilotTables.map(table => table.id))

const PILOT_STORE = {
  name: '珊瑚海',
  address: '江学路381弄22号（江学路文城路路口，原兰桥酒家）',
  phone: '37827177'
}

function withPilotRoomDefaults(storeName, table) {
  if (storeName !== PILOT_STORE.name || table.id !== '205' || table.name !== '205') return table
  return {
    ...table,
    floor: table.floor && table.floor !== '待确认' ? table.floor : '二楼',
    type: table.type && table.type !== 'unknown' ? table.type : 'room'
  }
}

function applyPilotMessageDefaults(state) {
  const {store} = state
  if (store.name !== PILOT_STORE.name || state.pilotMessageDefaultsApplied) return false
  store.address = store.address || PILOT_STORE.address
  store.phone = store.phone || PILOT_STORE.phone
  state.tables = state.tables.map(table => withPilotRoomDefaults(store.name, table))
  state.pilotMessageDefaultsApplied = true
  return true
}

function floorIsUnknown(table) {
  return !table.floor || table.floor === '待确认'
}

function findPilotTable(tables, template) {
  return tables.find(table => table.id === template.id) || tables.find(table =>
    !pilotTableIds.has(table.id) && table.name === template.name &&
    (table.floor === template.floor || floorIsUnknown(table)))
}

function applyPilotTableLayout(state) {
  if (state.store.name !== PILOT_STORE.name) return false
  if (state.pilotTableLayoutApplied) {
    if (state.pilotHallTablesApplied) return false
    const additions = pilotTables.filter(table => hallNames.includes(table.name) && !findPilotTable(state.tables, table))
    const insertAt = state.tables.map(table => table.floor).lastIndexOf('一楼') + 1
    state.tables.splice(insertAt, 0, ...additions.map(table => ({ ...table })))
    state.pilotHallTablesApplied = true
    return true
  }

  const tables = state.tables.slice()
  const corrected = pilotTables.find(table => table.id === '203')
  const legacyIndex = tables.findIndex(table => table.id === '204' && table.name === '204' &&
    (table.floor === corrected.floor || floorIsUnknown(table)))
  if (legacyIndex >= 0 && !findPilotTable(tables, corrected)) {
    tables[legacyIndex] = { ...tables[legacyIndex], id: corrected.id, name: corrected.name }
    for (const order of state.orders) {
      const index = order.tableIds.indexOf('204')
      if (index < 0) continue
      order.tableIds[index] = corrected.id
      if (order.tableNames[index] === '204') order.tableNames[index] = corrected.name
    }
  }

  const matched = new Set()
  const updated = pilotTables.map(template => {
    const table = findPilotTable(tables, template)
    if (!table) return { ...template }
    matched.add(table.id)
    const useDefaultFloor = floorIsUnknown(table) && !tables.some(other =>
      other.id !== table.id && other.name === table.name && other.floor === template.floor)
    const capacity = table.capacity ?? template.capacity
    const minCapacity = table.minCapacity ?? (template.minCapacity <= capacity ? template.minCapacity : null)
    return {
      ...table,
      floor: useDefaultFloor ? template.floor : table.floor,
      type: !table.type || table.type === 'unknown' ? template.type : table.type,
      minCapacity,
      capacity,
    }
  })
  state.tables = updated.concat(tables.filter(table => !matched.has(table.id)))
  state.pilotTableLayoutApplied = true
  state.pilotHallTablesApplied = true
  return true
}

function pilotLayout() {
  const layout = {
    store: { ...PILOT_STORE },
    tables: pilotTables.map(table => ({ ...table })),
    pilotTableLayoutApplied: true,
    pilotHallTablesApplied: true,
  }
  applyPilotMessageDefaults(layout)
  return layout
}

module.exports = { PILOT_STORE, pilotLayout, withPilotRoomDefaults, applyPilotMessageDefaults, applyPilotTableLayout }
