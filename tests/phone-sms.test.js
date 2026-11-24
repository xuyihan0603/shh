const test = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {runInNewContext} = require('node:vm')
const {seed} = require('./fixtures/store')
const {today,execute} = require('../miniprogram/lib/domain')
const {pilotLayout} = require('../miniprogram/lib/pilot')
const invitation = require('../miniprogram/lib/invitation')
const {notificationDetails} = require('../server/notifications')

function smsPage(platform = 'ios', channel = 'sms', smsOverrides = {}, createInvitationImage = async () => 'wxfile://tmp/test.jpg') {
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
    require(name) {
      if (name.endsWith('/invitation-image')) return {createInvitationImage}
      return name.endsWith('/api') ? api : invitation
    }
  })
  page.setData = (values, done) => { Object.assign(page.data, values); if (done) done() }
  page.createSelectorQuery = () => ({
    select() {return this}, fields() {return this}, exec(callback) {callback([{node: {}}])},
  })
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
    assert.match(clipboard[0].data, /本店地址:江学路381弄22号/)
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
  const channels = template.split('<block wx:if="{{smsOnly}}">')[1]
  const splitAt = channels.indexOf('<block wx:else>')
  const sms = channels.slice(0, splitAt), share = channels.slice(splitAt)
  assert.equal((sms.match(/<button\b/g) || []).length, 1)
  assert.match(sms, /复制原文并打开短信/)
  assert.match(share, /bindtap="openChat"/)
  assert.match(share, /bindtap="sendCloud"/)
  assert.doesNotMatch(template, /精简短信/)

  const {page, wx, started, cloudCalls} = smsPage('ios', 'message', {enabled: true})
  let confirmation
  wx.showModal = options => { confirmation = options.success }
  await page.load()
  assert.equal(started.length, 0)
  assert.equal(page.data.cloudEnabled, true)

  page.sendCloud()
  assert.deepEqual(cloudCalls, [])
  confirmation({confirm: true})
  await new Promise(setImmediate)
  assert.equal(cloudCalls.length, 1)
  assert.equal(page.data.cloudStatus, 'accepted')
})

test('编辑后的预订文字和门头合为同一份草稿，发送一次图片并省略地址', async () => {
  const images = new Map()
  const {page, wx} = smsPage('android', 'message', {}, async (_, text, photo) => {
    const path = 'wxfile://tmp/poster-' + images.size + '.jpg'
    images.set(path, {text, photo})
    return path
  })
  const storage = new Map()
  let chatUrl
  const sent = []
  wx.env = {USER_DATA_PATH: 'wxfile://usr'}
  wx.canIUse = () => true
  wx.setStorageSync = (key, value) => storage.set(key, value)
  wx.getStorageSync = key => storage.get(key)
  wx.removeStorageSync = key => storage.delete(key)
  wx.getWindowInfo = () => ({statusBarHeight: 24})
  wx.getFileSystemManager = () => ({
    readdirSync: () => [], copyFileSync: (src, dest) => images.set(dest, images.get(src)),
    unlinkSync: path => images.delete(path),
  })
  wx.openChatTool = options => {chatUrl = options.url; options.success()}
  wx.shareImageToGroup = options => {sent.push(images.get(options.imagePath)); options.success()}
  await show(page)
  const updatedText = page.data.message + '\n请提前十分钟到店。'
  assert.doesNotMatch(updatedText, /本店地址|江学路|门店定位|https?:\/\//)
  page.editMessage()
  page.changeText({detail: {value: updatedText}})
  page.finishEditing({currentTarget: {dataset: {}}})
  await page.imageWork
  page.openChat()
  let chat
  runInNewContext(readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index.js'), 'utf8'), {
    wx, Page(definition) {chat = definition},
  })
  chat.setData = data => Object.assign(chat.data, data)
  chat.onLoad({token: new URL(chatUrl, 'https://example.test').searchParams.get('token')})
  assert.deepEqual(sent, [])
  chat.shareInvitation()
  assert.deepEqual(sent, [{text: updatedText, photo: '/assets/storefront.jpg'}])
  assert.equal(storage.size, 0)
  page.onHide()
  await show(page)
  assert.equal(page.data.message, updatedText)
})

test('离开页面时尚未导出的预订图不会重新显示或发起分享', async () => {
  let resolveImage
  const {page, wx} = smsPage('android', 'message', {}, () => new Promise(resolve => {resolveImage = resolve}))
  wx.openChatTool = () => assert.fail('不能打开旧草稿')
  await show(page)
  assert.equal(page.data.generating, true)
  page.onHide()
  resolveImage('wxfile://tmp/obsolete.jpg')
  await page.imageWork
  assert.equal(page.data.invitationImagePath, '')
  page.openChat()
})
