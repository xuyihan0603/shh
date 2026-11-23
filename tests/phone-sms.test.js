const test = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {runInNewContext} = require('node:vm')
const {seed} = require('./fixtures/store')
const {today,execute} = require('../miniprogram/lib/domain')
const {pilotLayout} = require('../miniprogram/lib/pilot')
const invitation = require('../miniprogram/lib/invitation')
const {notificationDetails} = require('../server/notifications')

const copyPhone = {currentTarget: {dataset: {field: 'phone'}}}
const copyMessage = {currentTarget: {dataset: {field: 'message'}}}

function smsPage(platform = 'ios') {
  const state = Object.assign(seed(), pilotLayout())
  const owner = state.staff.find(person => person.id === 'sales1')
  owner.nameBound = true
  const order = execute(state, owner.id, 'save', {
    date: today(), meal: 'dinner', time: '18:00', tableIds: ['201', '202'], guests: 10,
    contact: '林女士', phone: '13800000001', deposit: 500, depositMethod: '微信', depositHandler: '前台',
  })
  owner.nameBound = false
  execute(state, 'front', 'bindStaffName', {name: '陈小宁'})
  execute(state, 'sales2', 'bindStaffName', {name: '周晓萱'})
  let actor = 'front'
  const store = {
    run: (id, action, data) => execute(state, id, action, data),
    notificationStatus: () => 'ready',
  }
  const api = {
    call(action, {id}) {
      assert.equal(action, 'notificationDetails')
      return notificationDetails(store, actor, id, {})
    },
  }
  const started = []
  const clipboard = []
  const device = {platform}
  const wx = {
    getDeviceInfo: () => device,
    canIUse: name => name === 'sendSms',
    setNavigationBarTitle() {}, hideShareMenu() {},
    sendSms: options => started.push(options),
    setClipboardData: options => clipboard.push(options)
  }
  let page
  runInNewContext(readFileSync(require.resolve('../miniprogram/pages/notify/index.js'), 'utf8'), {
    Page(definition) {page = definition}, wx,
    require(name) {return name.endsWith('/api') ? api : invitation}
  })
  page.setData = values => Object.assign(page.data, values)
  page.onLoad({id: order.id, channel: 'sms'})
  return {page, wx, device, started, clipboard, state, selectActor(id) {actor = id}}
}

async function show(page) {
  page.onShow()
  await new Promise(setImmediate)
}

test('员工手机打开短信编辑器时预填客人号码与用餐资料，取消后不记为已发送', async () => {
  const {page, device, started, state, selectActor} = smsPage()
  execute(state, 'sales1', 'bindStaffName', {name: '徐', servicePhone: '13800000002'})
  await page.load()
  assert.equal(page.data.canCompose, true)
  assert.equal(started.length, 0)
  page.compose()
  page.compose()
  assert.equal(started.length, 1)
  assert.equal(started[0].phoneNumber, '13800000001')
  for (const text of ['感謝您預订《珊瑚海》用餐', '餐位:二楼201、202', '人数10位！', '小李专职为您服务：13800000002', '订餐电话：37827177']) {
    assert.ok(started[0].content.includes(text), text)
  }
  assert.match(started[0].content, /用餐時間:\d+月\d+日\(周[日一二三四五六]\)晚宴/)
  assert.doesNotMatch(started[0].content, /13800000001|订金|500|林女士/)
  started[0].fail({errMsg: 'sendSms:fail cancel'})
  started[0].complete()
  assert.equal(page.data.cloudStatus, 'ready')
  assert.equal(page.data.opening, '')
  assert.equal(page.data.smsMode, 'full')
  assert.equal(page.data.smsDiagnostic, '')

  device.platform = 'devtools'
  await page.load()
  assert.equal(page.data.canCompose, false)
  assert.equal(page.data.smsMode, 'manual')
  assert.equal(page.data.message, started[0].content)
  page.compose()
  assert.equal(started.length, 1)

  page.onHide()
  selectActor('sales2')
  await page.load()
  assert.equal(page.data.phone, '')
  assert.equal(page.data.card, null)
  assert.match(page.data.error, /无权/)
})

test('安卓默认复制完整正文，复制成功后才只带客人号码打开短信', async () => {
  const {page, started, clipboard} = smsPage('android')
  await page.load()
  const {phone, message} = page.data
  assert.equal(page.data.smsMode, 'number')

  page.compose()
  assert.equal(started.length, 0)
  page.copy(copyPhone)
  assert.equal(clipboard[0].data, phone)
  clipboard[0].success()
  page.compose()
  assert.equal(started.length, 0)

  page.copy(copyMessage)
  assert.equal(clipboard[1].data, message)
  page.compose()
  page.copy(copyPhone)
  assert.equal(started.length, 0)
  assert.equal(clipboard.length, 2)
  clipboard[1].fail()
  assert.equal(page.data.copyStatus, 'failed')
  page.compose()
  assert.equal(started.length, 0)

  page.copy(copyMessage)
  assert.equal(clipboard[2].data, message)
  clipboard[2].success()
  assert.equal(page.data.copyStatus, 'success')
  assert.equal(started.length, 0)

  page.compose()
  page.compose()
  assert.equal(started.length, 1)
  assert.equal(started[0].phoneNumber, phone)
  assert.equal(Object.hasOwn(started[0], 'content'), false)
  started[0].fail({errMsg: 'sendSms:fail system error', errCode: 50322})
  started[0].complete()
  assert.equal(page.data.smsMode, 'manual')
  assert.match(page.data.smsDiagnostic, /50322/)
  assert.equal(page.data.opening, '')
  assert.equal(page.data.cloudStatus, 'ready')

  page.compose()
  assert.equal(started.length, 2)
  assert.equal(Object.hasOwn(started[1], 'content'), false)
  started[1].success()
  assert.equal(page.data.smsMode, 'number')
})

test('安卓可直接打开精简短信，只带号码打开失败后也仍可使用', async () => {
  const {page, started, clipboard} = smsPage('android')
  await page.load()

  page.composeShort()
  assert.equal(clipboard.length, 0)
  assert.equal(started.length, 1)
  assert.equal(started[0].phoneNumber, page.data.phone)
  assert.equal(started[0].content, page.data.shortSms.message)
  assert.match(started[0].content, /^珊瑚海预订 \d{2}\/\d{2} \d{2}:\d{2} 二楼201、202 10位$/)
  assert.ok(Buffer.byteLength(started[0].content, 'utf8') <= 64)
  started[0].fail({errMsg: 'sendSms:fail 内容超出正文上限'})
  assert.equal(page.data.smsMode, 'number')
  assert.match(page.data.smsDiagnostic, /内容超出正文上限/)
  assert.match(page.data.smsHint, /复制完整正文/)

  page.copy(copyMessage)
  assert.equal(clipboard[0].data, page.data.message)
  clipboard[0].success()
  page.compose()
  assert.equal(Object.hasOwn(started[1], 'content'), false)
  started[1].fail({errMsg: 'sendSms:fail system error'})
  assert.equal(page.data.smsMode, 'manual')

  page.composeShort()
  assert.equal(started[2].content, started[0].content)
  started[2].success()
  assert.equal(page.data.smsMode, 'manual')
  assert.equal(page.data.smsDiagnostic, '')
  assert.equal(page.data.cloudStatus, 'ready')
})

test('预填号码和正文的手机也可直接选择兼容方式', async () => {
  const {page, started, clipboard} = smsPage()
  await page.load()
  page.copyForNumberOnly(copyMessage)
  assert.equal(started.length, 0)
  assert.equal(clipboard[0].data, page.data.message)
  clipboard[0].success()
  page.compose()
  assert.equal(started.length, 1)
  assert.equal(started[0].phoneNumber, page.data.phone)
  assert.equal(Object.hasOwn(started[0], 'content'), false)
  started[0].success()
  assert.equal(page.data.opening, '')
  assert.equal(page.data.cloudStatus, 'ready')
})

test('手机预填遇到正文上限时解除打开状态并保留错误码', async () => {
  const {page, wx} = smsPage()
  await page.load()
  wx.sendSms = () => {
    throw Object.assign(new Error('内容超出正文上限'), {errCode: 50323})
  }

  page.compose()
  assert.equal(page.data.opening, '')
  assert.equal(page.data.smsMode, 'number')
  assert.equal(page.data.smsDiagnostic, '内容超出正文上限 · 50323')
})

test('页面切回后恢复短信处理方式，订单权限撤销时清空预订信息', async () => {
  const {page, started, clipboard, selectActor} = smsPage('android')
  await show(page)
  const message = page.data.message

  page.copy(copyMessage)
  clipboard[0].success()
  page.compose()
  page.onHide()
  assert.equal(page.data.card, null)
  assert.equal(page.data.phone, '')
  assert.equal(page.data.message, '')
  started[0].fail({errMsg: 'sendSms:fail system error', errCode: 50324})
  started[0].complete()

  await show(page)
  assert.equal(page.data.smsMode, 'manual')
  assert.match(page.data.smsDiagnostic, /50324/)
  assert.equal(page.data.opening, '')
  assert.equal(page.data.message, message)

  page.copy(copyMessage)
  page.onHide()
  selectActor('sales2')
  await show(page)
  clipboard[1].success()

  assert.match(page.data.error, /无权/)
  assert.equal(page.data.card, null)
  assert.equal(page.data.phone, '')
  assert.equal(page.data.message, '')
  assert.equal(page.data.smsDiagnostic, '')
  assert.equal(page.data.copyStatus, '')
  assert.equal(page.data.canCompose, false)
  page.compose()
  page.composeShort()
  assert.equal(started.length, 1)
})
