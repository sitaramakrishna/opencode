// Streaming timeouts (provider.<id>.options.headerTimeout / chunkTimeout) against test/lib/local-server.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMError, Message } from "@opencode-ai/llm"
import type { ResolvedConfig } from "../../src/contract"
import { streamTimeouts } from "../../src/llm/client"
import { reply, startLocalServer, type LocalServer } from "../lib/local-server"
import { tmpdir } from "../lib/tmp"
import { collect, config, joined, pinned, turn, withGateway } from "./gateway"

const data = await tmpdir()
const previous = process.env.XDG_DATA_HOME
beforeAll(() => {
  process.env.XDG_DATA_HOME = data.path
})
afterAll(async () => {
  process.env.XDG_DATA_HOME = previous
  await data[Symbol.asyncDispose]()
})

const user = [Message.user("hi")]

function withLimits(server: LocalServer, options: { headerTimeout?: number | false; chunkTimeout?: number | false }): ResolvedConfig {
  const cfg = config(server, { pins: pinned() })
  return { ...cfg, provider: { local: { ...cfg.provider.local, options: { baseURL: server.url, ...options } } } }
}

function run(cfg: ResolvedConfig) {
  return withGateway(cfg, (gateway) =>
    Effect.gen(function* () {
      const handle = yield* gateway.resolve("local/test-model")
      return yield* collect(gateway, handle, turn({ messages: user })).pipe(Effect.result)
    }),
  )
}

function failure(result: Awaited<ReturnType<typeof run>>) {
  if (result._tag === "Success") throw new Error("expected a timeout")
  const error = result.failure
  if (!(error instanceof LLMError)) throw error
  return error
}

describe("streaming timeouts", () => {
  test("headers later than headerTimeout: Timeout transport error naming the option", async () => {
    await using server = await startLocalServer({ header_delay_ms: 600 })
    server.queue(reply.text("late"))
    const error = failure(await run(withLimits(server, { headerTimeout: 150 })))
    expect(error.reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
    expect(error.reason.message).toContain(`no response from ${server.url} within 0.15 s`)
    expect(error.reason.message).toContain("prefill of a large prompt on a slow local model")
    expect(error.reason.message).toContain("raise provider.local.options.headerTimeout")
  })

  test("a stall between chunks longer than chunkTimeout: Timeout error", async () => {
    await using server = await startLocalServer({ chunk_delay_ms: 400 })
    server.queue(reply.text("slow words here"))
    const error = failure(await run(withLimits(server, { chunkTimeout: 120 })))
    expect(error.reason).toMatchObject({ _tag: "Transport", kind: "Timeout" })
    expect(error.reason.message).toContain("stalled: no data for 0.12 s")
    expect(error.reason.message).toContain("provider.local.options.chunkTimeout")
  })

  test("delays under both limits succeed", async () => {
    await using server = await startLocalServer({ header_delay_ms: 80, chunk_delay_ms: 20 })
    server.queue(reply.text("fine"))
    const result = await run(withLimits(server, { headerTimeout: 1000, chunkTimeout: 500 }))
    if (result._tag === "Failure") throw result.failure
    expect(joined(result.success, "text-delta")).toBe("fine")
  })

  test("reasoning chunks keep the stream alive past chunkTimeout in total", async () => {
    // 2 chars per delta → ~15 reasoning chunks 30 ms apart: ~450 ms of thinking, never a 150 ms gap.
    await using server = await startLocalServer({ chunk_delay_ms: 30, delta_chars: 2 })
    server.queue([reply.reasoning("thinking hard..."), reply.text("ok")])
    const result = await run(withLimits(server, { chunkTimeout: 150 }))
    if (result._tag === "Failure") throw result.failure
    expect(joined(result.success, "reasoning-delta")).toBe("thinking hard...")
    expect(joined(result.success, "text-delta")).toBe("ok")
  })

  test("false disables the timeouts", async () => {
    await using server = await startLocalServer({ header_delay_ms: 250, chunk_delay_ms: 120 })
    server.queue(reply.text("ok"))
    const cfg = withLimits(server, { headerTimeout: false, chunkTimeout: false })
    expect(streamTimeouts(cfg, { ref: "local/test-model", baseURL: server.url })).toEqual({ header: false, chunk: false })
    const result = await run(cfg)
    if (result._tag === "Failure") throw result.failure
    expect(joined(result.success, "text-delta")).toBe("ok")
  })

  test("defaults: loopback 30 min / 10 min, hosted and remote 300 s like opencode", async () => {
    await using server = await startLocalServer()
    const cfg = config(server)
    expect(streamTimeouts(cfg, { ref: "local/m", baseURL: "http://127.0.0.1:8080/v1" })).toEqual({ header: 1_800_000, chunk: 600_000 })
    expect(streamTimeouts(cfg, { ref: "local/m", baseURL: "http://localhost:1234/v1" })).toEqual({ header: 1_800_000, chunk: 600_000 })
    expect(streamTimeouts(cfg, { ref: "anthropic/m", baseURL: "https://api.anthropic.com/v1" })).toEqual({ header: 300_000, chunk: 300_000 })
    expect(streamTimeouts(cfg, { ref: "lan/m", baseURL: "http://192.168.1.20:8000/v1" })).toEqual({ header: 300_000, chunk: 300_000 })
    // An explicit value wins over the loopback default.
    expect(streamTimeouts(withLimits(server, { headerTimeout: 5000 }), { ref: "local/m", baseURL: server.url })).toEqual({ header: 5000, chunk: 600_000 })
  })
})
