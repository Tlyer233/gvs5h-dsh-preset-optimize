// /test-inject: both children get args.task verbatim (text after /test-inject).
const task = String(args.task || "")
phase("hard-1")
const a = await agent(task, { label: "hard-a" })
phase("hard-2")
const b = await agent(task, { label: "hard-b" })
return { test: true, hardA: a, hardB: b }
