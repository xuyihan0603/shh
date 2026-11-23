function seed() {
  return {
    store: { name: '示例门店', address: '示例路 88 号', phone: '010-55550100' },
    staff: [
      { id: 'front', name: '前台', role: 'front' },
      { id: 'manager', name: '店长', role: 'manager' },
      { id: 'sales1', name: '小李', role: 'sales' },
      { id: 'sales2', name: '小周', role: 'sales' },
      { id: 'finance', name: '财务', role: 'finance' },
    ],
    tables: [
      { id: '101', name: '101', floor: '一楼', type: 'hall', capacity: 4 },
      { id: '102', name: '102', floor: '一楼', type: 'hall', capacity: 4 },
      { id: '103', name: '103', floor: '一楼', type: 'hall', capacity: 6 },
      { id: '104', name: '104', floor: '一楼', type: 'hall', capacity: 6 },
      { id: '201', name: '201', floor: '二楼', type: 'room', capacity: 8 },
      { id: '202', name: '202', floor: '二楼', type: 'room', capacity: 10 },
      { id: '203', name: '203', floor: '二楼', type: 'room', capacity: 12 },
    ],
    orders: [],
    nextOrderNumber: 1,
  }
}

module.exports = {seed}
