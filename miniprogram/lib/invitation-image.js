const PADDING = 36
const PHOTO_GAP = 22
const MAX_PHOTO_HEIGHT = 690
const MIN_PHOTO_HEIGHT = 340
// WeChat limits a Canvas 2D component's backing dimensions to 1365 × 1365.
const MAX_CANVAS_SIDE = 1365
const layouts = [[736, 32], [736, 30], [736, 28], [960, 32], [1140, 30], [1360, 26]]

const emojiJoiner = '\u200d'
const combiningMark = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f]/
const wordCharacter = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9_'’-]/

function splitCommonGraphemes(text) {
  const groups = []
  let joinNext = false
  let firstFlagCharacter = false
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    const isFlagCharacter = codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff
    const extendsGroup = character === emojiJoiner || combiningMark.test(character) ||
      (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) || (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
      (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    if (groups.length && (joinNext || extendsGroup || (firstFlagCharacter && isFlagCharacter))) {
      groups[groups.length - 1] += character
    } else {
      groups.push(character)
    }
    joinNext = character === emojiJoiner
    firstFlagCharacter = isFlagCharacter && !firstFlagCharacter
  }
  return groups
}

function splitParagraphs(text) {
  const lines = text.replace(/\t/g, '    ').split(/\r\n?|\n|\u2028|\u2029/)
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })
      return lines.map(line => Array.from(segmenter.segment(line), item => item.segment))
    }
  } catch (_) {
    // Some WeChat engines expose Intl without usable grapheme segmentation.
  }
  return lines.map(splitCommonGraphemes)
}

function canBreakAfter(character, nextCharacter) {
  if (/^[（【《「『“‘(]/.test(character) || /^[\s、，。！？：；…）】》」』”’.,!?;:%)]/.test(nextCharacter)) return false
  return !(wordCharacter.test(character) && wordCharacter.test(nextCharacter))
}

function wrapLine(context, characters, availableWidth) {
  const rows = []
  let start = 0
  let preferredBreak = 0
  let row = ''

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]
    const next = row + character
    if (context.measureText(next).width > availableWidth) {
      if (!row) return null
      const end = preferredBreak > start ? preferredBreak : index
      rows.push(end === index ? row : characters.slice(start, end).join(''))
      start = end
      preferredBreak = end
      index = end - 1
      row = ''
      continue
    }

    row = next
    if (canBreakAfter(character, characters[index + 1] || '')) preferredBreak = index + 1
  }

  rows.push(row)
  return rows
}

function layoutInvitation(context, text, photo) {
  const paragraphs = splitParagraphs(text)
  for (const [width, fontSize] of layouts) {
    const availableWidth = width - 2 * PADDING
    const maxPhotoHeight = photo ? Math.min(MAX_PHOTO_HEIGHT, Math.floor(availableWidth * photo.height / photo.width)) : 0
    const photoGap = photo ? PHOTO_GAP : 0
    const availableHeight = MAX_CANVAS_SIDE - 2 * PADDING - photoGap - Math.min(MIN_PHOTO_HEIGHT, maxPhotoHeight)
    const font = `${fontSize}px sans-serif`
    const lineHeight = Math.ceil(fontSize * 1.4)
    if (paragraphs.length * lineHeight > availableHeight) continue

    context.font = font
    const rows = [].concat(...paragraphs.map(paragraph => wrapLine(context, paragraph, availableWidth)))
    const textHeight = rows.length * lineHeight
    if (textHeight > availableHeight || rows.includes(null)) continue

    const photoY = PADDING + textHeight + photoGap
    const photoHeight = Math.min(maxPhotoHeight, MAX_CANVAS_SIDE - photoY - PADDING)
    const photoWidth = photo ? Math.round(photoHeight * photo.width / photo.height) : 0
    const height = photoY + photoHeight + PADDING
    return { rows, font, fontSize, lineHeight, width, height, photoY, photoWidth, photoHeight }
  }
  const error = new Error('预订正文太长，无法生成清晰的图片。')
  error.code = 'TEXT_TOO_LONG'
  throw error
}

function loadPhoto(canvas, photoPath) {
  return new Promise((resolve, reject) => {
    const photo = canvas.createImage()
    const fail = () => reject(new Error('无法读取门头照片。'))
    photo.onload = () => {
      if (photo.width > 0 && photo.height > 0) resolve(photo)
      else fail()
    }
    photo.onerror = fail
    photo.src = photoPath
  })
}

function exportImage(canvas, width, height) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('无法导出预订图片。'))
    wx.canvasToTempFilePath({
      canvas, x: 0, y: 0, width, height,
      destWidth: width, destHeight: height, fileType: 'jpg', quality: 0.94,
      success: ({ tempFilePath }) => tempFilePath ? resolve(tempFilePath) : fail(),
      fail,
    })
  })
}

async function createInvitationImage(canvas, text, photoPath = null) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('没有可生成图片的预订正文。')
  if (typeof canvas?.getContext !== 'function' || typeof wx.canvasToTempFilePath !== 'function') {
    throw new Error('当前微信无法生成预订图片。')
  }

  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前微信无法绘制预订图片。')

  const photo = photoPath ? await loadPhoto(canvas, photoPath) : null
  const { rows, font, fontSize, lineHeight, width, height, photoY, photoWidth, photoHeight } = layoutInvitation(context, text, photo)
  canvas.width = width
  canvas.height = height

  context.fillStyle = '#F6F4EE'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#103947'
  context.font = font
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  rows.forEach((row, index) => {
    if (row) context.fillText(row, PADDING, PADDING + fontSize + index * lineHeight)
  })
  if (photo) context.drawImage(photo, (width - photoWidth) / 2, photoY, photoWidth, photoHeight)

  return exportImage(canvas, width, height)
}

module.exports = { createInvitationImage }
