const tableNames = [
  '101','103','105','卡1',
  '201','202','204','205','206','207','208','209','210','211','阳光房B1',
  '301','302','303','305','306','307','308','309','310'
]

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

function pilotLayout() {
  const floors = {'1':'一楼','2':'二楼','3':'三楼'}
  const layout = {
    store:{...PILOT_STORE},
    tables:tableNames.map(name=>({
      id:name,name,
      floor:/^[123]\d{2}$/.test(name) ? floors[name[0]] : '待确认',
      type:'unknown',capacity:null
    }))
  }
  applyPilotMessageDefaults(layout)
  return layout
}

module.exports = {PILOT_STORE, pilotLayout, withPilotRoomDefaults, applyPilotMessageDefaults}
