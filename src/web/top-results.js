// Keep the same stable ranking as a complete sort, retaining only its best K.
export function topResults(values, compare, limit = 100) {
  if (limit <= 0) return [];
  const heap = []; let index = 0;
  const order = (a, b) => compare(a.value, b.value) || a.index - b.index;
  for (const value of values) {
    const item = { value, index: index++ };
    if (heap.length < limit) {
      heap.push(item); let child = heap.length - 1;
      while (child) {
        const parent = (child - 1) >> 1;
        if (order(heap[child], heap[parent]) <= 0) break;
        [heap[child], heap[parent]] = [heap[parent], heap[child]]; child = parent;
      }
    } else if (order(item, heap[0]) < 0) {
      heap[0] = item; let parent = 0;
      while (true) {
        const left = parent * 2 + 1, right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && order(heap[right], heap[left]) > 0 ? right : left;
        if (order(heap[child], heap[parent]) <= 0) break;
        [heap[child], heap[parent]] = [heap[parent], heap[child]]; parent = child;
      }
    }
  }
  return heap.sort(order).map(item => item.value);
}
