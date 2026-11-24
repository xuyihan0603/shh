const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')
const { publicInvitation, invitationText } = require('../miniprogram/lib/invitation')
const { pilotLayout } = require('../miniprogram/lib/pilot')

const source = readFileSync(require.resolve('../miniprogram/lib/invitation-image'), 'utf8')
const photoPath = '/assets/storefront.jpg'
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })

function canvasHarness({ useSegmenter = true } = {}) {
  const frames = []
  const photos = []
  const context = {
    measureText(text) {
      const em = parseInt(this.font, 10)
      let width = 0
      for (const { segment } of segmenter.segment(text)) {
        width += /^ $/.test(segment) ? em * 0.3 : /^[!-~]$/.test(segment) ? em * 0.55 : em
      }
      return { width }
    },
    fillRect() { this.rows = []; this.photo = null },
    fillText(text, x, y) { this.rows.push({ text, x, y, width: this.measureText(text).width }) },
    drawImage(...args) { this.photo = args },
  }
  const canvas = {
    getContext: () => context,
    createImage() {
      return {
        width: 1080, height: 1440,
        set src(path) {
          photos.push(path)
          queueMicrotask(() => this.onload())
        },
      }
    },
  }
  const wx = {
    canvasToTempFilePath(options) {
      frames.push({ options, rows: context.rows, photo: context.photo })
    },
  }

  const module = { exports: {} }
  runInNewContext(source, { module, wx, Intl: useSegmenter ? Intl : {} })
  const render = (text, picture) => module.exports.createInvitationImage(canvas, text, picture)
  return { render, frames, photos, canvas }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('全店桌位的预订图完整折行，保留段落、英文、表情及门头照片', async () => {
  const { render, frames, photos, canvas } = canvasHarness({ useSegmenter: false })
  const { store, tables } = pilotLayout()
  const order = {
    date: '2026-11-24', meal: 'dinner', guests: 300,
    tableIds: tables.map(table => table.id), tableNames: tables.map(table => table.name),
    ownerName: '王'.repeat(40), ownerServicePhone: '13800000002',
  }
  const message = invitationText(publicInvitation({ ...store, address: '' }, order, tables))
  const welcome = 'Thank you for booking with us! ' + 'ONLINEBOOKING'.repeat(10)
  const emoji = '凌晨在东海，晚上在餐桌 🦞👩🏽‍🍳🇨🇳1️⃣'
  const lines = [...message.split('\n'), '', welcome, emoji]
  const result = render(lines.join('\r\n'), photoPath)
  await tick()

  assert.deepEqual(photos, [photoPath])
  assert.equal(frames.length, 1)
  const [{ options, rows, photo }] = frames
  assert.equal(options.canvas, canvas)
  assert.equal(options.destWidth, canvas.width)
  assert.equal(options.destHeight, canvas.height)
  assert.ok(canvas.width <= 1365 && canvas.height <= 1365)
  assert.ok(rows.every(row => row.width + row.x <= canvas.width - row.x))
  const blankLineAfter = rows.findIndex(row => row.text === '🦞凌晨在东海，晚上在餐桌🦞')
  assert.ok(blankLineAfter > 0)
  assert.ok(rows[blankLineAfter + 1].y - rows[blankLineAfter].y > rows[1].y - rows[0].y)
  assert.equal(rows.map(row => row.text).join(''), lines.join(''))

  const characters = Array.from(segmenter.segment(lines.join('')), item => item.segment)
  const renderedCharacters = rows.flatMap(row => Array.from(segmenter.segment(row.text), item => item.segment))
  assert.deepEqual(renderedCharacters, characters)

  const [image, x, y, width, height] = photo
  assert.ok(Math.abs(width / height - image.width / image.height) < 0.001)
  assert.ok(x >= 0 && x + width <= canvas.width && y + height <= canvas.height)
  assert.ok(y > rows.at(-1).y)
  options.success({ tempFilePath: 'wxfile://tmp_invitation.jpg' })
  assert.equal(await result, 'wxfile://tmp_invitation.jpg')
})

test('没有门头照片时仍可导出预订图，超出可读范围的正文返回明确错误', async () => {
  const { render, frames, photos } = canvasHarness()
  await assert.rejects(render('预订备注\n'.repeat(200), null), { code: 'TEXT_TOO_LONG' })
  assert.equal(frames.length, 0)

  const result = render('其他门店的预订正文', null)
  assert.deepEqual(photos, [])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].rows[0].text, '其他门店的预订正文')
  assert.equal(frames[0].photo, null)
  frames[0].options.success({ tempFilePath: 'wxfile://tmp_invitation.jpg' })
  assert.equal(await result, 'wxfile://tmp_invitation.jpg')
})
