const { PILOT_STORE, withPilotRoomDefaults } = require('./pilot')
const { normalizeServicePhone } = require('./domain')

function describeTables(storeName, tableNames, tableIds = [], tables = []) {
  const groups = new Map()
  tableNames.forEach((name, index) => {
    const id = tableIds[index]
    const matches = tables.filter(table => id ? table.id === id : table.name === name)
    const table = matches.length > 1 ? {} : withPilotRoomDefaults(storeName, matches[0] || {id: id || name, name})
    const floor = table.floor && table.floor !== '待确认' ? table.floor : ''
    const label = table.type === 'room' && !/包[房间]$/.test(name) ? name + '包房' : name
    if (!groups.has(floor)) groups.set(floor, [])
    groups.get(floor).push(label)
  })
  return Array.from(groups, ([floor, names]) => {
    const prefix = floor && !names[0].startsWith(floor) ? floor : ''
    return prefix + names.join('、')
  }).join('，')
}

function singleLine(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

function serviceFields(serviceName, phone) {
  if (!serviceName) return {}
  const servicePhone = normalizeServicePhone(phone)
  return servicePhone ? { serviceName, servicePhone } : { serviceName }
}

function serviceContactLine({ serviceName, servicePhone }) {
  if (!serviceName) return ''
  return `${serviceName}专职为您服务${servicePhone ? `：${servicePhone}` : ''}`
}

function publicInvitation(store, order, tables = [], owner) {
  const originalStaff = order.ownerId && owner?.id === order.ownerId ? owner : null
  const serviceName = singleLine(order.ownerName) || singleLine(originalStaff?.name)
  const servicePhone = originalStaff ? originalStaff.servicePhone : order.ownerServicePhone
  const tableNames = order.tableNames || (order.tableIds || []).map(id => tables.find(table => table.id === id)?.name || id)
  return {
    store: store.name, address: store.address || '', phone: store.phone || '',
    date: order.date, meal: order.meal, time: order.time,
    tableNames, tableLabel: describeTables(store.name, tableNames, order.tableIds, tables),
    ...serviceFields(serviceName, servicePhone),
    guests: order.guests, status: order.status
  }
}

function invitationText(card) {
  const store = card.store || PILOT_STORE.name
  const defaults = store === PILOT_STORE.name ? PILOT_STORE : {address: '', phone: ''}
  const address = typeof card.address === 'string' ? card.address : defaults.address
  const phone = typeof card.phone === 'string' ? card.phone : defaults.phone
  const date = new Date(card.date + 'T00:00:00Z')
  const weekday = '日一二三四五六'[date.getUTCDay()]
  const meal = card.meal === 'lunch' ? '午宴' : '晚宴'
  const tableLabel = card.tableLabel || describeTables(store, card.tableNames)
  const service = serviceContactLine(card)
  return [
    '尊敬的贵宾您好！',
    `感謝您預订《${store}》用餐`,
    `用餐時間:${date.getUTCMonth() + 1}月${date.getUTCDate()}日(周${weekday})${meal}`,
    `餐位:${tableLabel}`,
    `人数${card.guests}位！`,
    '正宗台州小网海鲜',
    '🦞凌晨在东海，晚上在餐桌🦞',
    '',
    ...(service ? [service] : []),
    ...(address ? [`本店地址:${address}`] : []),
    ...(phone ? [`订餐电话：${phone}`] : []),
    `${store}全体员工期待您的光临!`,
  ].join('\n')
}

function smsFields(card) {
  return [card.store, card.date, card.meal === 'lunch' ? '午餐' : '晚餐', card.time || '待定', card.tableNames.join('、')]
}

module.exports = { publicInvitation, invitationText, smsFields, serviceContactLine }
