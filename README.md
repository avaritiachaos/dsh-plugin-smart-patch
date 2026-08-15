# @shion-lab/dsh-plugin-smart-patch

[![npm version](https://img.shields.io/npm/v/@shion-lab/dsh-plugin-smart-patch.svg)](https://www.npmjs.com/package/@shion-lab/dsh-plugin-smart-patch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Micro-surgical fault-tolerant code patching engine with 4-tier fuzzy matching for DeepSeek Harness (`dsh`).**

---

## 🌟 Why `dsh-plugin-smart-patch`?

AI coding agents often fail at applying diffs because of:
- Minor whitespace / indentation drift (e.g. 2 spaces vs 4 spaces).
- Line ending mismatches (`\r\n` vs `\n`).
- Non-essential comment differences in search blocks.

`@shion-lab/dsh-plugin-smart-patch` introduces **4-tier cascading matching**:
1. **Tier 1**: Exact Substring Match (100% confidence).
2. **Tier 2**: Whitespace-Normalized Line Match (survives tab/space indentation drift).
3. **Tier 3**: Unique Anchor-Based Boundary Match (locks unique prefix/suffix lines).
4. **Tier 4**: Levenshtein Distance Fallback.

---

## 📦 Installation & Usage

```bash
npm install -g @shion-lab/dsh-plugin-smart-patch
```

In `cordis.yml`:

```yaml
plugins:
  "@deepseek-ai/dsh": {}
  "@shion-lab/dsh-plugin-smart-patch":
    createBackup: false
```

---

## 📄 License

MIT © [Shion Lab](https://github.com/shion-lab)
