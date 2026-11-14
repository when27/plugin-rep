import { SETTINGS_SCHEMA, DEFAULTS } from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-tier-router/lib/schema.js'

const cases = {
  old: { hardProvider: 'deepseek-account', hardModel: 'deepseek-flash' },
  new: { easyFallbacks: [{ provider: 'google-vertex', model: 'gemini-3.5-flash' }] },
  malformedString: { easyFallbacks: 'google/gemini-3.5-flash' },
  malformedNumber: { easyFallbacks: [42] },
  malformedObject: { easyFallbacks: [{ provider: 7 }] },
  unknown: { foo: 1 },
}
for (const [name, value] of Object.entries(cases)) {
  try {
    const out = SETTINGS_SCHEMA(value)
    console.log(name, 'OK', JSON.stringify(out))
  } catch (error) {
    console.log(name, 'ERR', String(error?.message ?? error))
  }
}
console.log('DEFAULTS has easyFallbacks:', Object.hasOwn(DEFAULTS, 'easyFallbacks'))
