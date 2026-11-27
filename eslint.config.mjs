import electronToolkitTs from '@electron-toolkit/eslint-config-ts'
import electronToolkitPrettier from '@electron-toolkit/eslint-config-prettier'
import sveltePlugin from 'eslint-plugin-svelte'
import svelteParser from 'svelte-eslint-parser'

export default [
  {
    ignores: [
      'dist/**',
      'out/**',
      'resources/**',
      'bin/**',
      'ios/**',
      'android/**',
      '**/* copy*',
      '**/*DELETE*',
      '**/*DELETEE*',
      '**/*DELEETE*',
      'src/renderer/src/components/common/react/build-fluent.mjs',
      // Output of the web e2e suite (tests/e2e/README.md): a bundle and reports.
      'tests/e2e/.web-dist/**',
      'tests/e2e/.stub-root/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
  ...electronToolkitTs.configs.recommended,
  ...sveltePlugin.configs['flat/recommended'],
  electronToolkitPrettier,
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: electronToolkitTs.parser,
        extraFileExtensions: ['.svelte']
      }
    }
  },
  {
    rules: {
      'svelte/no-unused-svelte-ignore': 'off'
    }
  }
]
