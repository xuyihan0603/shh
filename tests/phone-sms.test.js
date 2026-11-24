const test = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {runInNewContext} = require('node:vm')
const {seed} = require('./fixtures/store')
const {today,execute} = require('../miniprogram/lib/domain')
const {pilotLayout} = require('../miniprogram/lib/pilot')
const invitation = require('../miniprogram/lib/invitation')
const {notificationDetails} = require('../server/notifications')

function smsPage(platform = 'ios', channel = 'sms', smsOverrides = {}) {
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
  const cloudCalls = []
  const api = {
    async call(action, input) {
      if (action === 'notifySms') {
        cloudCalls.push(input)
        return {sent: true}
      }
      assert.equal(action, 'notificationDetails')
      const details = await notificationDetails(store, actor, input.id, {})
      return {...details, sms: {...details.sms, ...smsOverrides}}
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
  page.onLoad({id: order.id, channel})
  return {page, wx, started, clipboard, cloudCalls, state, selectActor(id) {actor = id}}
}

async function show(page) {
  page.onShow()
  await new Promise(setImmediate)
}

test('安卓和 iOS 点击一次后先复制完整正文，再仅用客人号码打开短信', async () => {
  for (const platform of ['android', 'ios']) {
    const {page, started, clipboard, state, cloudCalls} = smsPage(platform)
    execute(state, 'sales1', 'bindStaffName', {name: '徐', servicePhone: '13800000002'})
    await page.load()
    assert.equal(page.data.canCompose, true)

    page.copy()
    page.copy()
    assert.equal(clipboard.length, 1)
    assert.equal(clipboard[0].data, page.data.message)
    assert.match(clipboard[0].data, /餐位:二楼201包房、202包房\n人数10位！/)
    assert.match(clipboard[0].data, /🦞凌晨在东海，晚上在餐桌🦞\n\n小李专职为您服务：13800000002/)
    assert.match(clipboard[0].data, /珊瑚海全体员工期待您的光临!$/)
    assert.equal(started.length, 0)

    clipboard[0].success()
    page.copy()
    assert.equal(clipboard.length, 1)
    assert.equal(started.length, 1)
    assert.equal(started[0].phoneNumber, '13800000001')
    assert.equal(Object.hasOwn(started[0], 'content'), false)

    started[0].fail({errMsg: 'sendSms:fail cancel'})
    started[0].complete()
    assert.equal(page.data.opening, false)
    assert.equal(page.data.copyStatus, 'success')
    assert.equal(page.data.smsDiagnostic, '')
    assert.deepEqual(cloudCalls, [])
  }
})

test('复制失败时留下原文供手动复制，打开失败时保留手动发送指引和重试入口', async () => {
  const {page, wx, started, clipboard} = smsPage('android')
  await page.load()
  const message = page.data.message

  page.copy()
  clipboard[0].fail()
  assert.equal(page.data.copyStatus, 'failed')
  assert.equal(page.data.message, message)
  assert.equal(started.length, 0)

  wx.sendSms = () => { throw Object.assign(new Error('内容超出正文上限'), {errCode: 50323}) }
  page.copy()
  clipboard[1].success()
  assert.equal(page.data.opening, false)
  assert.equal(page.data.copyStatus, 'success')
  assert.equal(page.data.smsDiagnostic, '内容超出正文上限 · 50323')
  assert.match(page.data.smsHint, /手动打开手机短信.*粘贴正文/)
  assert.equal(clipboard[1].data, message)
})

test('微信不支持打开短信或缺少收件号码时仍可复制原文', async () => {
  const unavailable = [smsPage('devtools'), smsPage('ios', 'sms', {phone: ''})]
  for (const {page, started, clipboard} of unavailable) {
    await page.load()
    page.copy()
    assert.equal(clipboard[0].data, page.data.message)
    clipboard[0].success()
    assert.equal(page.data.copyStatus, 'success')
    assert.equal(started.length, 0)
  }
})

test('离开页面后迟到的剪贴板回调不会打开短信，订单权限撤销后清空预订信息', async () => {
  const {page, started, clipboard, selectActor} = smsPage('android')
  await show(page)
  page.copy()
  page.onHide()
  await show(page)

  page.copy()
  clipboard[0].success()
  assert.equal(started.length, 0)
  clipboard[1].success()
  assert.equal(started.length, 1)

  page.onHide()
  started[0].fail({errMsg: 'sendSms:fail system error', errCode: 50324})
  await show(page)
  assert.match(page.data.smsDiagnostic, /50324/)
  assert.equal(page.data.opening, false)

  page.onHide()
  selectActor('sales2')
  await show(page)
  assert.match(page.data.error, /无权/)
  assert.equal(page.data.card, null)
  assert.equal(page.data.phone, '')
  assert.equal(page.data.message, '')
  assert.equal(page.data.smsDiagnostic, '')
  page.copy()
  assert.equal(clipboard.length, 2)
})

test('手机短信页只提供一个按钮，预订消息页保留微信分享和已启用的云短信', async () => {
  const template = readFileSync(require.resolve('../miniprogram/pages/notify/index.wxml'), 'utf8')
  const [sms, share] = template.split('<block wx:if="{{smsOnly}}">')[1].split('<block wx:else>')
  assert.equal((sms.match(/<button\b/g) || []).length, 1)
  assert.match(sms, /复制原文并打开短信/)
  assert.match(share, /bindtap="openChat"/)
  assert.match(share, /bindtap="sendCloud"/)
  assert.doesNotMatch(template, /精简短信/)

  const {page, wx, started, clipboard, cloudCalls} = smsPage('ios', 'message', {enabled: true})
  let confirmation
  wx.showModal = options => { confirmation = options.success }
  await page.load()
  page.copy()
  clipboard[0].success()
  assert.equal(started.length, 0)
  assert.equal(page.data.cloudEnabled, true)

  page.sendCloud()
  assert.deepEqual(cloudCalls, [])
  confirmation({confirm: true})
  await new Promise(setImmediate)
  assert.equal(cloudCalls.length, 1)
  assert.equal(page.data.cloudStatus, 'accepted')
})

test('微信预订草稿跨独立分包传递门头原图与地图，读取照片失败仍可分享定位文字', async () => {
  const {page, wx} = smsPage('android', 'message')
  const storage = new Map()
  const files = new Map()
  const original = readFileSync(require.resolve('../miniprogram/assets/storefront.jpg'))
  let chatUrl, image, location
  wx.env = {USER_DATA_PATH: 'wxfile://usr'}
  wx.canIUse = () => true
  wx.setStorageSync = (key, value) => storage.set(key, value)
  wx.getStorageSync = key => storage.get(key)
  wx.removeStorageSync = key => storage.delete(key)
  wx.getWindowInfo = () => ({statusBarHeight: 24})
  wx.getFileSystemManager = () => ({
    readFileSync: path => readFileSync(require.resolve('../miniprogram' + path)),
    writeFileSync: (path, bytes) => files.set(path, bytes),
  })
  wx.openChatTool = options => {chatUrl = options.url; options.success()}
  wx.shareImageToGroup = options => {image = files.get(options.imagePath); options.success()}
  wx.openLocation = options => {location = options}
  async function enterChat() {
    await page.load()
    page.openChat()
    let chat
    runInNewContext(readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index.js'), 'utf8'), {
      wx, Page(definition) {chat = definition},
    })
    chat.setData = data => Object.assign(chat.data, data)
    chat.onLoad({token: new URL(chatUrl, 'https://example.test').searchParams.get('token')})
    assert.match(chat.data.text, /https:\/\/map\.wap\.qq\.com\/\S*uid=7237907789162872389/)
    assert.equal(storage.size, 0)
    return chat
  }
  const chat = await enterChat()
  chat.shareStorefront()
  assert.deepEqual(image, original)
  chat.openStoreLocation()
  assert.equal(location.latitude, 31.031818)
  assert.equal(location.longitude, 121.211192)
  wx.getFileSystemManager = () => {throw new Error('local storage unavailable')}
  const fallback = await enterChat()
  assert.equal(fallback.data.storefrontImagePath, '')
  assert.equal(fallback.data.hasText, true)
})
