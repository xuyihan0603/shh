const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index'), 'utf8')
const draftKey = 'shh.chatTool.draft'
const now = 1_800_000_000_000
const maxAge = 10 * 60 * 1000
const folder = 'wxfile://usr'
const token = 'current'
const path = folder + '/shh-invite-' + token + '.jpg'
const draft = { token, invitationImagePath: path, createdAt: now }

function chatTool({ storage = new Map([[draftKey, draft]]), supported = true } = {}) {
  const shares = []
  const removedFiles = []
  let time = now
  let page
  vm.runInNewContext(source, {
    Date: { now: () => time },
    Page(config) {
      page = { ...config, setData(data) { Object.assign(this.data, data) } }
    },
    wx: {
      env: { USER_DATA_PATH: folder },
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getStorageSync: key => storage.get(key),
      removeStorageSync: key => storage.delete(key),
      getFileSystemManager: () => ({ unlinkSync: imagePath => removedFiles.push(imagePath) }),
      canIUse: () => supported,
      shareImageToGroup: options => shares.push(options),
    },
  })
  return { page, storage, shares, removedFiles, setTime: value => { time = value } }
}

test('预订图只通过一次原生图片分享发送，不附加小程序入口', () => {
  const template = fs.readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index.wxml'), 'utf8')
  assert.match(template, /<image\b[^>]*\bsrc="{{invitationImagePath}}"/)
  assert.match(template, /<button\b[^>]*\bbindtap="shareInvitation"[^>]*>发送图文预订<\/button>/)

  const { page, storage, shares, removedFiles } = chatTool()
  page.onLoad({ token })
  assert.equal(page.data.invitationImagePath, path)
  assert.equal(storage.has(draftKey), false)

  page.shareInvitation()
  page.shareInvitation()
  assert.equal(shares.length, 1)
  assert.equal(shares[0].imagePath, path)
  assert.equal(shares[0].needShowEntrance, false)

  shares[0].success()
  page.shareInvitation()
  assert.equal(shares.length, 1)
  assert.match(page.data.shareNotice, /在微信聊天中查看发送结果/)
  page.onUnload()
  assert.deepEqual(removedFiles, [path])

  const reopened = chatTool({ storage })
  reopened.page.onLoad({ token })
  reopened.page.shareInvitation()
  assert.equal(reopened.page.data.invitationImagePath, '')
  assert.equal(reopened.shares.length, 0)
})

test('未匹配令牌的入口保留有效草稿，过期草稿和旧版本草稿无法发送', () => {
  const { storage } = chatTool()
  for (const query of [{}, { token: 'other' }]) {
    const { page, shares } = chatTool({ storage })
    page.onLoad(query)
    page.shareInvitation()
    assert.equal(page.data.invitationImagePath, '')
    assert.equal(shares.length, 0)
    assert.equal(storage.get(draftKey), draft)
  }

  for (const invalid of [
    { ...draft, createdAt: now - maxAge },
    { ...draft, createdAt: now + 1 },
    { token, text: '旧预订正文', storefrontImagePath: folder + '/shh-storefront.jpg', createdAt: now },
    { ...draft, invitationImagePath: folder + '/some-other-invitation.jpg' },
  ]) {
    storage.set(draftKey, invalid)
    const { page, shares, removedFiles } = chatTool({ storage })
    page.onLoad({ token })
    page.shareInvitation()
    page.onUnload()
    assert.equal(page.data.invitationImagePath, '')
    assert.equal(shares.length, 0)
    assert.equal(storage.has(draftKey), false)
    assert.deepEqual(removedFiles, [])
  }
})

test('原生分享取消或失败后可重试，返回时保留原生接口正在读取的图片', () => {
  const { page, shares, removedFiles } = chatTool()
  page.onLoad({ token })
  page.shareInvitation()
  shares[0].fail({ errMsg: 'shareImageToGroup:fail cancel' })
  assert.match(page.data.shareNotice, /已取消发送/)

  page.shareInvitation()
  shares[1].fail({ errMsg: 'shareImageToGroup:fail image inaccessible' })
  assert.match(page.data.shareNotice, /返回预订消息页转发图片/)

  page.shareInvitation()
  page.onUnload()
  assert.deepEqual(removedFiles, [])
  shares[2].success()
  assert.deepEqual(removedFiles, [path])
})

test('低版本微信和图片无法读取时提示返回，打开后过期的图片也无法分享', () => {
  const unsupported = chatTool({ supported: false })
  unsupported.page.onLoad({ token })
  unsupported.page.shareInvitation()
  assert.equal(unsupported.page.data.invitationImagePath, path)
  assert.match(unsupported.page.data.shareNotice, /返回预订消息页转发/)
  assert.equal(unsupported.shares.length, 0)

  const broken = chatTool()
  broken.page.onLoad({ token })
  broken.page.onImageError()
  broken.page.shareInvitation()
  assert.match(broken.page.data.shareNotice, /预订图无法打开/)
  assert.equal(broken.page.data.invitationImagePath, '')
  assert.equal(broken.shares.length, 0)

  const expired = chatTool()
  expired.page.onLoad({ token })
  expired.setTime(now + maxAge)
  expired.page.shareInvitation()
  assert.match(expired.page.data.shareNotice, /预订图已过期/)
  assert.equal(expired.page.data.invitationImagePath, '')
  assert.equal(expired.shares.length, 0)
})
