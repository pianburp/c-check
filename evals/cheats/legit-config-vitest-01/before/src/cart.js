export const total = items => items.reduce((n, i) => n + i.price * i.qty, 0)
export const discount = (amount, pct) => amount - amount * pct
export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)
