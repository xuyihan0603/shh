const { PILOT_STORE, withPilotRoomDefaults } = require('./pilot')
const { normalizeServicePhone } = require('./domain')

// Keep a small prefill budget because WeChat clients can reject longer bodies.
const COMPACT_SMS_MAX_BYTES = 64

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

function utf8Bytes(text) {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

function shorten(text, budget) {
  if (utf8Bytes(text) <= budget) return text
  let result = ''
  let remaining = budget - utf8Bytes('…')
  for (const char of text) {
    remaining -= utf8Bytes(char)
    if (remaining < 0) break
    result += char
  }
  return result.trimEnd() + '…'
}

function compactSms(card) {
  const store = singleLine(card.store)
  const table = singleLine(card.tableLabel || card.tableNames.join('、')) || '餐位待定'
  const date = card.date.slice(5, 10).replace('-', '/')
  const time = card.time || (card.meal === 'lunch' ? '午餐' : '晚餐')
  const schedule = `${date} ${time}`
  const booking = `预订 ${schedule}`
  const guests = `${card.guests}位`
  const hasServiceContact = Boolean(card.serviceName && card.servicePhone)
  if (hasServiceContact) {
    const details = `${schedule} ${table} ${guests} ${card.serviceName} ${card.servicePhone}`
    for (const message of [`${store}预订 ${details}`, `${store} ${details}`]) {
      if (utf8Bytes(message) <= COMPACT_SMS_MAX_BYTES) return { message, note: '' }
    }
  }

  const labelBudget = COMPACT_SMS_MAX_BYTES - utf8Bytes(`${booking}  ${guests}`)
  const tableBudget = Math.max(Math.floor(labelBudget / 2), labelBudget - utf8Bytes(store))
  const notes = []
  let tableLabel = table
  if (utf8Bytes(table) > tableBudget) {
    if (card.tableNames.length > 1) {
      tableLabel = `共${card.tableNames.length}桌`
      notes.push('餐位以桌数显示。')
    } else {
      tableLabel = shorten(table, tableBudget)
      notes.push('餐位名称已缩写。')
    }
  }
  const storeLabel = shorten(store, labelBudget - utf8Bytes(tableLabel))
  if (storeLabel !== store) notes.push('门店名称已缩写。')
  if (hasServiceContact) notes.push('精简短信未含服务联系方式，完整正文中可查看。')

  const message = `${storeLabel}${booking} ${tableLabel} ${guests}`
  return { message: utf8Bytes(message) <= COMPACT_SMS_MAX_BYTES ? message : '', note: notes.join('') }
}

function smsFields(card) {
  return [card.store, card.date, card.meal === 'lunch' ? '午餐' : '晚餐', card.time || '待定', card.tableNames.join('、')]
}

module.exports = { publicInvitation, invitationText, compactSms, smsFields, serviceContactLine }
