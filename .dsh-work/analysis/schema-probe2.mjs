import z from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs'

const schema = z.object({
  easyFallbacks: z.array(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
  })).default([]),
})

const cases = {
  old: {},
  new: { easyFallbacks: [{ provider: 'google-vertex', model: 'gemini-3.5-flash' }] },
  string: { easyFallbacks: 'google/gemini-3.5-flash' },
  number: { easyFallbacks: [42] },
  partial: { easyFallbacks: [{ provider: 7 }] },
  nullValue: { easyFallbacks: null },
  arrayOfStrings: { easyFallbacks: ['a/b'] },
}
for (const [name, value] of Object.entries(cases)) {
  try {
    console.log(name, 'OK', JSON.stringify(schema(value)))
  } catch (error) {
    console.log(name, 'ERR', String(error?.message ?? error).split('\n')[0])
  }
}
