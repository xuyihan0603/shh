const assert = require('node:assert/strict')
const test = require('node:test')
const { once } = require('node:events')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { crc32 } = require('node:zlib')
const {seed} = require('./fixtures/store')
const { execute } = require('../miniprogram/lib/domain')
const mobile = require('../miniprogram/lib/workbook')
const server = require('../server/export')
const { createServer } = require('../server')
const { openStore } = require('../server/database')

function readParts(archive) {
  const parts = new Map()
  for (let start = 0; archive.readUInt32LE(start) === 0x04034B50;) {
    assert.equal(archive.readUInt16LE(start + 8), 0, 'ZIP entries must be stored uncompressed')
    const length = archive.readUInt32LE(start + 18)
    const nameLength = archive.readUInt16LE(start + 26)
    const name = archive.toString('utf8', start + 30, start + 30 + nameLength)
    const dataStart = start + 30 + nameLength + archive.readUInt16LE(start + 28)
    const bytes = archive.subarray(dataStart, dataStart + length)
    assert.equal(crc32(bytes), archive.readUInt32LE(start + 14), `ZIP CRC matches ${name}`)
    parts.set(name, bytes.toString('utf8'))
    start = dataStart + length
  }
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054B50)
  assert.equal(archive.readUInt16LE(archive.length - 12), parts.size)
  return parts
}

test('网页和微信导出相同的双表 Excel，保留多桌、散客、取消、未录金额及零金额', () => {
  const state = seed()
  state.staff.find(person => person.id === 'sales1').name = '=1<&2🐟'
  const names = { front: '王晓玲', manager: '林树', finance: '陈伟' }
  for (const person of state.staff) execute(state, person.id, 'bindStaffName', { name: names[person.id] || person.name })
  const date = '2026-01-01'
  const createdDate = '2025-12-31'
  const instant = new Date('2026-01-01T12:00:00+08:00')
  const booking = { date, meal: 'dinner', time: '18:00', guests: 8, contact: '林女士', phone: '13800001234' }
  const [first] = execute(state, 'manager', 'import', { orders: [{
    ...booking, tableIds: ['201', '202'], ownerId: 'sales1', createdDate, deposit: 500, depositMethod: '微信',
  }] }, instant)
  execute(state, 'front', 'settle', { id: first.id, version: first.version, amount: 2400 }, instant)
  const cancelled = execute(state, 'sales2', 'save', { ...booking, tableIds: ['203'], time: '18:30', deposit: 100, depositMethod: '现金' }, instant)
  execute(state, 'front', 'cancel', { id: cancelled.id, version: cancelled.version }, instant)
  const walkin = execute(state, 'front', 'save', { kind: 'walkin', date, meal: 'lunch', time: '12:00', tableIds: ['101'], guests: 4 }, instant)
  execute(state, 'front', 'settle', { id: walkin.id, version: walkin.version, amount: 0 }, instant)
  const pending = execute(state, 'sales2', 'save', { ...booking, date: '2026-01-31', tableIds: ['203'] }, instant)

  const report = execute(state, 'finance', 'report', { date, basis: 'meal' })
  const archive = server.buildWorkbook(report)
  assert(Buffer.isBuffer(archive))
  const mobileArchive = mobile.buildWorkbook(report)
  assert(mobileArchive instanceof Uint8Array)
  assert.deepEqual(archive, Buffer.from(mobileArchive))

  const parts = readParts(archive)
  assert.match(parts.get('xl/workbook.xml'), /name="员工汇总".*name="订单明细"/)
  const summary = parts.get('xl/worksheets/sheet1.xml')
  const details = parts.get('xl/worksheets/sheet2.xml')
  assert.match(summary, /统计口径 · 用餐日/)
  assert.match(summary, /<c r="A\d+" t="inlineStr"><is><t xml:space="preserve">=1&lt;&amp;2🐟<\/t>/)
  assert.match(summary, /<t xml:space="preserve">合计<\/t>.*<c r="B\d+" s="5"><v>2<\/v>.*<c r="C\d+" s="5"><v>3<\/v>.*<c r="D\d+" s="6"><v>2400<\/v>.*<c r="E\d+" s="5"><v>0<\/v>.*<c r="F\d+" s="6"><v>500<\/v>/)
  assert.equal(details.split(first.id).length, 2)
  assert.match(details, /201、202.*<c r="G\d+"><v>2<\/v>.*<t xml:space="preserve">已结账<\/t>.*<c r="J\d+" s="2"><v>2400<\/v>.*<c r="K\d+" s="2"><v>500<\/v>/)
  assert.match(details, /已取消<\/t><\/is><\/c><c r="J\d+" s="2"\/><c r="K\d+" s="2"><v>100<\/v>/)
  assert.match(details, /散客.*?<c r="J\d+" s="2"><v>0<\/v>/)
  assert.doesNotMatch(details, /<f>|林女士|13800001234|接单日/)
  assert.match(details, /用餐日/)
  assert(!details.includes(pending.id))

  const yesterday = execute(state, 'finance', 'report', { date: createdDate, basis: 'created' })
  assert(!readParts(server.buildWorkbook(yesterday)).get('xl/worksheets/sheet2.xml').includes(first.id))

  const january = execute(state, 'finance', 'report', { date: '2026-01-15', period: 'month' })
  const januaryParts = readParts(server.buildWorkbook(january))
  assert.match(januaryParts.get('xl/worksheets/sheet1.xml'), /用餐月份.*<c r="B1" t="inlineStr"><is><t xml:space="preserve">2026-01<\/t>/)
  const januaryDetails = januaryParts.get('xl/worksheets/sheet2.xml')
  assert.equal(januaryDetails.split(first.id).length, 2)
  assert.match(januaryDetails, new RegExp(`${pending.id}.*<c r="C6" s="3"><v>46053</v>.*已预订</t></is></c><c r="J6" s="2"/>`))
  assert.doesNotMatch(januaryDetails, /接单日/)
})

test('网页月报导出按用餐月份取数，并沿用财务和店长权限', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'shh-report-download-'))
  const store = openStore(directory, { adminPassword: 'manager-report-test-password' })
  const http = createServer(store)
  t.after(async () => {
    await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')

  store.run('manager', 'bindStaffName', { name: '林经理' })
  const signIn = (id, name, role) => {
    const password = 'staff-report-test-password'
    store.run('manager', 'staffSave', { id, name, role, password })
    store.run(id, 'bindStaffName', { name })
    return store.login(id, password).token
  }
  const finance = signIn('finance', '小陈', 'finance')
  const sales = signIn('sales', '小周', 'sales')
  const [order] = store.run('manager', 'import', { orders: [{
    ownerId: 'manager', date: '2000-01-09', createdDate: '1999-12-30', meal: 'dinner', time: '18:00',
    guests: 4, tableIds: ['201'], contact: '林女士', phone: '13800001234',
  }] })
  store.run('manager', 'settle', { id: order.id, version: order.version, amount: 100.25 })

  const fetchAs = (route, token) => fetch(`http://127.0.0.1:${http.address().port}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const current = '/api/export?date=2000-01-01&period=month&basis=created'
  const [monthly, daily, anonymous, wrongRole, invalidPeriod] = await Promise.all([
    fetchAs(current, finance),
    fetchAs('/api/export?date=1999-12-30&basis=created', finance),
    fetchAs(current),
    fetchAs(current, sales),
    fetchAs('/api/export?date=2000-01-01&period=week', finance),
  ])
  assert.equal(monthly.status, 200)
  assert.match(monthly.headers.get('content-disposition'), /monthly-report\.xlsx/)
  const monthlyParts = readParts(Buffer.from(await monthly.arrayBuffer()))
  assert.match(monthlyParts.get('xl/worksheets/sheet2.xml'), new RegExp(order.id))
  assert.match(monthlyParts.get('xl/worksheets/sheet1.xml'), /<v>100\.25<\/v>/)
  assert.equal(daily.status, 200)
  assert.match(daily.headers.get('content-disposition'), /daily-report\.xlsx/)
  const dailyParts = readParts(Buffer.from(await daily.arrayBuffer()))
  assert(!dailyParts.get('xl/worksheets/sheet2.xml').includes(order.id))
  assert.equal(anonymous.status, 401)
  assert.equal(wrongRole.status, 403)
  assert.equal(invalidPeriod.status, 400)
})
