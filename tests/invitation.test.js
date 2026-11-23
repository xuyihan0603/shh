const test = require('node:test')
const assert = require('node:assert/strict')
const { publicInvitation, invitationText, compactSms, smsFields } = require('../miniprogram/lib/invitation')
const { pilotLayout, applyPilotMessageDefaults } = require('../miniprogram/lib/pilot')

test('珊瑚海邀请正文使用接单员工服务信息，且保持云短信参数兼容', () => {
  const { store, tables } = pilotLayout()
  const order = {
    date: '2026-11-21', meal: 'dinner', time: '18:30', tableIds: ['205'], tableNames: ['205'], guests: 8,
    ownerId: 'seller-1', ownerName: '徐', ownerServicePhone: '13800000002',
    status: 'booked', contact: '林女士', phone: '13800000001', deposit: 500, notes: '仅员工可见',
  }
  const card = publicInvitation(store, order, tables)
  assert.equal(invitationText(card), `尊敬的贵宾您好！
感謝您預订《珊瑚海》用餐
用餐時間:11月21日(周六)晚宴
餐位:二楼205包房
人数8位！
正宗台州小网海鲜
🦞凌晨在东海，晚上在餐桌🦞

徐专职为您服务：13800000002
本店地址:江学路381弄22号（江学路文城路路口，原兰桥酒家）
订餐电话：37827177
珊瑚海全体员工期待您的光临!`)
  assert.deepEqual(smsFields(card), ['珊瑚海', '2026-11-21', '晚餐', '18:30', '205'])
  assert.doesNotMatch(JSON.stringify(card), /林女士|13800000001|500|仅员工可见|seller-1|ownerName|ownerServicePhone/)
})

test('邀请沿用接单时的姓名，使用原员工当前号码并尊重清除号码', () => {
  const store = { name: '测试门店', phone: '13800000004' }
  const order = {
    date: '2026-11-21', meal: 'dinner', tableNames: ['101'], guests: 4,
    ownerId: 'sales1', ownerName: '徐', ownerServicePhone: '13800000002', phone: '13800000001',
  }
  const originalStaff = { id: 'sales1', name: '现员工姓名', servicePhone: '+86 138-0000-0003' }
  const latest = publicInvitation(store, order, [], originalStaff)
  assert.match(invitationText(latest), /\n徐专职为您服务：13800000003\n/)

  const cleared = publicInvitation(store, order, [], { ...originalStaff, servicePhone: '' })
  assert.equal(cleared.servicePhone, undefined)
  const body = invitationText(cleared)
  assert.match(body, /\n徐专职为您服务\n订餐电话：13800000004\n/)
  assert.doesNotMatch(body, /13800000001|13800000002|13800000003/)

  const otherStaff = { id: 'sales2', name: '其他员工', servicePhone: '13800000005' }
  const missingStaff = publicInvitation(store, order, [], otherStaff)
  assert.match(invitationText(missingStaff), /\n徐专职为您服务：13800000002\n/)

  const oldOrder = { ...order, ownerServicePhone: undefined }
  assert.equal(publicInvitation(store, oldOrder, [], originalStaff).servicePhone, '13800000003')
  assert.equal(publicInvitation(store, oldOrder, [], otherStaff).servicePhone, undefined)
})

test('午宴正文显示全部桌位，同层只标一次楼层，并沿用当前门店资料', () => {
  const store = { name: '测试门店', address: '海城路 8 号', phone: '010-55550100' }
  const tables = [
    { id: 'A', name: '201', floor: '二楼', type: 'room' },
    { id: '205', name: '205', floor: '待确认', type: 'unknown' },
    { id: 'B', name: '202', floor: '二楼', type: 'unknown' },
    { id: 'C', name: '103', floor: '一楼', type: 'hall' },
    { id: 'D', name: '阳光房B1', floor: '待确认', type: 'unknown' },
  ]
  const order = {
    date: '2026-01-04', meal: 'lunch', guests: 14,
    tableIds: ['A', '205', 'B', 'C', 'D'], tableNames: ['201', '205', '202', '103', '阳光房B1'],
  }
  const card = publicInvitation(store, order, tables)
  const body = invitationText(card)
  assert.deepEqual(card.tableNames, order.tableNames)
  assert.match(body, /用餐時間:1月4日\(周日\)午宴\n餐位:二楼201包房、202，205、阳光房B1，一楼103\n人数14位！/)
  assert.match(body, /感謝您預订《测试门店》用餐/)
  assert.match(body, /本店地址:海城路 8 号\n订餐电话：010-55550100\n测试门店全体员工期待您的光临!$/)
})

test('精简短信在字节上限内保留完整姓名和服务手机号', () => {
  const { store, tables } = pilotLayout()
  const order = {
    date: '2026-11-23', meal: 'dinner', time: '18:30', tableIds: ['205'], guests: 8,
    ownerName: '徐志明', ownerServicePhone: '13800000002',
  }
  const { message, note } = compactSms(publicInvitation(store, order, tables))

  assert.equal(message, '珊瑚海 11/23 18:30 二楼205包房 8位 徐志明 13800000002')
  assert.ok(Buffer.byteLength(message, 'utf8') <= 64)
  assert.equal(note, '')
})

test('精简短信放不下完整服务联系方式时保留预订信息，并提示查看完整正文', () => {
  const store = { name: '海洋🦞宴会中心'.repeat(6) }
  const order = {
    date: '2026-11-23', meal: 'lunch', guests: 30,
    tableNames: ['东厅临海第一包间', '白鹭湾第二宴会厅', '翡翠厅206'],
    ownerName: '徐志明', ownerServicePhone: '13800000002',
  }
  const card = publicInvitation(store, order)
  const { message, note } = compactSms(card)

  assert.ok(Buffer.byteLength(message, 'utf8') <= 64)
  assert.match(message, /^海洋🦞.*…预订 11\/23 午餐 共3桌 30位$/)
  assert.doesNotMatch(message, /[\uD800-\uDFFF]/u)
  assert.match(note, /餐位以桌数显示/)
  assert.match(note, /门店名称已缩写/)
  assert.match(note, /精简短信未含服务联系方式，完整正文中可查看/)
  assert.match(invitationText(card), /徐志明专职为您服务：13800000002/)
  for (const name of order.tableNames) assert.ok(invitationText(card).includes(name))
})

test('旧珊瑚海配置补齐已知门店资料和 205 包房，并保留后续自定义设置', () => {
  const store = { name: '珊瑚海', address: '门店自定义地址', phone: '' }
  const tables = [
    { id: '205', name: '205', floor: '二楼', type: 'unknown', capacity: null },
    { id: '阳光房B1', name: '阳光房B1', floor: '待确认', type: 'unknown', capacity: null },
  ]
  const state = { store, tables }
  const order = { tableIds: ['205'], tableNames: ['205'] }
  assert.equal(publicInvitation(store, order, tables).tableLabel, '二楼205包房')
  assert.equal(applyPilotMessageDefaults(state), true)
  assert.equal(state.store.address, '门店自定义地址')
  assert.equal(state.store.phone, '37827177')
  assert.deepEqual(state.tables, [{ ...tables[0], type: 'room' }, tables[1]])
  state.store.phone = ''
  state.tables[0].type = 'unknown'
  assert.equal(applyPilotMessageDefaults(state), false)
  assert.equal(state.store.phone, '')
  assert.equal(state.tables[0].type, 'unknown')
})
