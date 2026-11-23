const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

const mealNames = { lunch: '午餐', dinner: '晚餐' }
const statusNames = { booked: '已预订', arrived: '已到店', cancelled: '已取消', settled: '已结账' }
const depositMethods = new Map(Object.entries({ cash: '现金', wechat: '微信', alipay: '支付宝', bank: '银行卡', other: '其他' }))

function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/_(?=x[\da-f]{4}_)/gi, '_x005F_')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;')
}

function utf8(text) {
  const bytes = new Uint8Array(text.length * 3)
  let position = 0
  for (let index = 0; index < text.length; index++) {
    let point = text.codePointAt(index)
    if (point > 0xFFFF) index++
    if (point >= 0xD800 && point <= 0xDFFF) point = 0xFFFD
    if (point < 0x80) {
      bytes[position++] = point
    } else if (point < 0x800) {
      bytes[position++] = 0xC0 | (point >> 6)
      bytes[position++] = 0x80 | (point & 0x3F)
    } else if (point < 0x10000) {
      bytes[position++] = 0xE0 | (point >> 12)
      bytes[position++] = 0x80 | ((point >> 6) & 0x3F)
      bytes[position++] = 0x80 | (point & 0x3F)
    } else {
      bytes[position++] = 0xF0 | (point >> 18)
      bytes[position++] = 0x80 | ((point >> 12) & 0x3F)
      bytes[position++] = 0x80 | ((point >> 6) & 0x3F)
      bytes[position++] = 0x80 | (point & 0x3F)
    }
  }
  return bytes.subarray(0, position)
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? (value >>> 1) ^ 0xEDB88320 : value >>> 1
  }
  return value
})

function crc32(bytes) {
  let value = 0xFFFFFFFF
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xFF]
  return (value ^ 0xFFFFFFFF) >>> 0
}

// The export contains only a few small parts and uses ZIP's uncompressed storage method.
function zip(files) {
  const local = []
  const central = []
  let localSize = 0
  let centralSize = 0

  for (const [filename, content] of files) {
    const name = utf8(filename)
    const data = utf8(content)
    const checksum = crc32(data)

    const localHeader = new Uint8Array(30 + name.length)
    const header = new DataView(localHeader.buffer)
    header.setUint32(0, 0x04034B50, true)
    header.setUint16(4, 20, true)
    header.setUint16(12, 33, true)
    header.setUint32(14, checksum, true)
    header.setUint32(18, data.length, true)
    header.setUint32(22, data.length, true)
    header.setUint16(26, name.length, true)
    localHeader.set(name, 30)

    const centralHeader = new Uint8Array(46 + name.length)
    const record = new DataView(centralHeader.buffer)
    record.setUint32(0, 0x02014B50, true)
    record.setUint16(4, 20, true)
    record.setUint16(6, 20, true)
    record.setUint16(14, 33, true)
    record.setUint32(16, checksum, true)
    record.setUint32(20, data.length, true)
    record.setUint32(24, data.length, true)
    record.setUint16(28, name.length, true)
    record.setUint32(42, localSize, true)
    centralHeader.set(name, 46)

    local.push(localHeader, data)
    central.push(centralHeader)
    localSize += localHeader.length + data.length
    centralSize += centralHeader.length
  }

  const closing = new Uint8Array(22)
  const directory = new DataView(closing.buffer)
  directory.setUint32(0, 0x06054B50, true)
  directory.setUint16(8, files.length, true)
  directory.setUint16(10, files.length, true)
  directory.setUint32(12, centralSize, true)
  directory.setUint32(16, localSize, true)

  const archive = new Uint8Array(localSize + centralSize + closing.length)
  let offset = 0
  for (const part of [...local, ...central, closing]) {
    archive.set(part, offset)
    offset += part.length
  }
  return archive
}

function dateSerial(date) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date || '')) return null
  const time = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(time)) return null
  const serial = time / 86400000 + 25569
  if (serial < 2) return date
  return serial < 61 ? serial - 1 : serial
}

function timeSerial(time) {
  if (!/^\d\d:\d\d$/.test(time || '')) return null
  const [hour, minute] = time.split(':').map(Number)
  return (hour * 60 + minute) / 1440
}

function column(index) {
  return String.fromCharCode(65 + index)
}

function writeRow(number, values, styles = []) {
  const cells = values.map((value, index) => {
    const ref = `${column(index)}${number}`
    const style = styles[index] ? ` s="${styles[index]}"` : ''
    if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`
  }).join('')
  return `<row r="${number}">${cells}</row>`
}

function worksheet(report, headers, widths, records, styles, options = {}) {
  const monthly = report.period === 'month'
  const label = monthly ? '用餐月份' : '统计口径 · 用餐日'
  const date = monthly ? report.date.slice(0, 7) : dateSerial(report.date)
  const lastCol = column(headers.length - 1)
  const lastRow = records.length + 2
  const columns = widths.map((width, index) => (
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  )).join('')
  const rows = records.map((record, index) => {
    const effectiveStyles = options.total && index === records.length - 1 ? options.total : styles
    return writeRow(index + 3, record, effectiveStyles)
  }).join('')
  return `${XML}<worksheet xmlns="${SPREADSHEET}">
  <dimension ref="A1:${lastCol}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columns}</cols>
  <sheetData>${writeRow(1, [label, date], [7, monthly ? 0 : 3])}${writeRow(2, headers, headers.map(() => 1))}${rows}</sheetData>
  ${options.filter ? `<autoFilter ref="A2:${lastCol}${lastRow}"/>` : ''}
  </worksheet>`
}

const styles = `${XML}<styleSheet xmlns="${SPREADSHEET}">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts>
  <fonts count="3">
    <font><sz val="11"/><color rgb="FF203930"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><color rgb="FF203930"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF21493A"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE5EDE7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="4" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

function summaryRow(name, row) {
  return [name, row.orderCount, row.tableCount, row.amount, row.pending, row.deposit]
}

function buildWorkbook(report) {
  const summary = worksheet(report, ['接单员工', '有效单数', '桌数', '已录消费额（元）', '金额待补笔数', '订金（元）'],
    [26, 12, 10, 22, 18, 18], [
      ...report.rows.map(row => summaryRow(row.name, row)),
      summaryRow('合计', report.total)
    ], [0, 0, 0, 2, 0, 2], { total: [5, 5, 5, 6, 5, 6] })

  const details = worksheet(report, [
    '订单编号', '接单员工', '用餐日', '餐段', '到店时间', '桌位', '桌数', '人数', '订单状态',
    '最终消费额（元）', '订金（元）', '订金收款方式', '订金经手人'
  ], [32, 16, 15, 10, 13, 28, 8, 8, 12, 22, 18, 16, 16], report.details.map(order => [
    order.id, order.kind === 'walkin' ? '散客' : order.ownerName, dateSerial(order.date),
    mealNames[order.meal], timeSerial(order.time), order.tableNames.join('、'), order.tableIds.length,
    order.guests, statusNames[order.status], order.amount, order.deposit,
    depositMethods.get(order.depositMethod) || order.depositMethod, order.depositHandler
  ]), [0, 0, 3, 0, 4, 0, 0, 0, 0, 2, 2], { filter: true })

  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      </Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="${PACKAGE_REL}">
      <Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${SPREADSHEET}" xmlns:r="${OFFICE_REL}">
      <bookViews><workbookView/></bookViews>
      <sheets><sheet name="员工汇总" sheetId="1" r:id="rId1"/><sheet name="订单明细" sheetId="2" r:id="rId2"/></sheets>
      </workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="${PACKAGE_REL}">
      <Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="${OFFICE_REL}/styles" Target="styles.xml"/>
      </Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', summary],
    ['xl/worksheets/sheet2.xml', details]
  ])
}

module.exports = { buildWorkbook }
