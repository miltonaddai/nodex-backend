let lastBirdeyeCall = 0
let lastHeliusCall = 0
let birdeyeGate: Promise<void> = Promise.resolve()
let heliusGate: Promise<void> = Promise.resolve()

export async function throttleBirdeye(minIntervalMs = 4000): Promise<void> {
  let release!: () => void
  const previous = birdeyeGate
  birdeyeGate = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    const now = Date.now()
    const wait = Math.max(0, minIntervalMs - (now - lastBirdeyeCall))
    if (wait > 0) await sleep(wait)
    lastBirdeyeCall = Date.now()
  } finally {
    release()
  }
}

export async function throttleHelius(minIntervalMs = 750): Promise<void> {
  let release!: () => void
  const previous = heliusGate
  heliusGate = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    const now = Date.now()
    const wait = Math.max(0, minIntervalMs - (now - lastHeliusCall))
    if (wait > 0) await sleep(wait)
    lastHeliusCall = Date.now()
  } finally {
    release()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
