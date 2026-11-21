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
      // Vendored libraries that ship their own eslint.config, which imports
      // @eslint/eslintrc (not a dependency here) and crashes the whole run.
      'src/renderer/src/components/common/web-component/vscode-elements/**',
      'src/renderer/src/extensions/tiptap/tiptap-pagination-plus-v1.1.2/**',
      // Prebuilt or minified third-party code. Once the vendored eslint
      // configs above stopped crashing the run, these files alone kept the CI
      // lint step running for hours, and they have nothing to fix in place:
      // pdf.js (~3.5 MB), minified and bundled scripts, and register-fluent.js,
      // which is the output of `npm run fluent:build` from register-fluent.ts.
      'src/renderer/pdfjs/**',
      'src/renderer/src/assets/js/vendor/**',
      'src/renderer/src/components/common/react/register-fluent.js',
      '**/*.min.{js,mjs,cjs}',
      '**/*.bundled.js'
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
