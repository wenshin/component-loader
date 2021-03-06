const { getOptions } = require('loader-utils')
const { promisify } = require('util')

const STYLE_PATH = './style/index'

function createOption (opt, parent) {
  const option = Object.assign({
    lib: '', // node_modules or regular_expression
    baseStyle: '',
    test: null, // RegExp or string
    assetsRule: /assets\/index\.(js|mjs|ts|jsx|tsx)$/,
    componentRule: /\/index\.(js|mjs|ts|jsx|tsx)$/,
    style: 'css'
  }, parent, opt)

  if (option.test) {
    option.test = new RegExp(option.test)
  }

  if (option.baseStyle) {
    option.baseStyle = `${option.baseStyle}.${option.style}`
  }

  option.stylePath = `${STYLE_PATH}.${option.style}`
  return option
}

function styleImport (isCommonJS, style) {
  return isCommonJS ? `\nrequire('${style}');\n` : `\nimport '${style}';\n`
}

function injectStyle (source, style, first) {
  const isCommonJS = source.search(/module\.exports/) > -1 || source.search(/exports\./) > -1 || source.search(/require\([^()]+\)/) > -1
  let styleCode = ''
  if (Array.isArray(style)) {
    styleCode = ''
    style.forEach(styl => {
      // 优先级高的样式放到后面加载
      styleCode = styleImport(isCommonJS, styl) + styleCode
    })
  } else {
    styleCode = styleImport(isCommonJS, style)
  }
  // put the style the end of the file will get the correct style override order
  return first ? `${styleCode}${source}` : `${source}${styleCode}`
}

const optionsCached = {
  baseStyles: [],
  components: null
}

async function cacheOptions (loader, context, components) {
  const options = {
    baseStyles: [],
    components: []
  }

  async function iter (_loader, _context, _components, _parent) {
    if (!_components) {
      return
    }

    for (const comp of _components) {
      const conf = createOption(comp, _parent && { style: _parent.style })
      if (conf.baseStyle) {
        try {
          const baseStyle = await _loader.resolve.promise(_context, conf.baseStyle)
          options.baseStyles.push(baseStyle)
        } catch (err) {
          if (_loader.mode === 'development') {
            console.log(`\n${conf.baseStyle} IS NOT RESOLVED`, err)
          }
        }
      }

      if (conf.lib) {
        try {
          const pkgPath = await _loader.resolve.promise(_context, `${conf.lib}/package.json`)
          const pkg = require(pkgPath)
          const ctx = pkgPath.replace('/package.json', '')

          conf.test = new RegExp(ctx)
          if (pkg.components) {
            await iter(_loader, ctx, pkg.components, conf)
          }
        } catch (err) {
          if (_loader.mode === 'development') {
            console.log(`\n${conf.lib} IS NOT A NODE_MODULE`, err)
          }
        }
      }
      options.components.push(conf)
    }
  }

  await iter(loader, context, components)
  optionsCached.components = options.components
  optionsCached.baseStyles = options.baseStyles
}

function processLoader (loader, source, cb) {
  let conf = null
  for (const comp of optionsCached.components) {
    if (loader.resourcePath.match(comp.test)) {
      conf = comp
    }
  }

  if (!conf) {
    return source
  }

  const isAssets = conf.assetsRule && loader.resourcePath.match(conf.assetsRule)

  if (isAssets) {
    // replace `export const JPG = './foo.jpg'` to `export { default as JPG } from './foo.jpg'`
    return source.replace(
      /export\s+(const|var|let)\s+(\w+)\s*=\s*(['"][^'"]+['"])/gm,
      'export { default as $2 } from $3'
    )
  }

  const asyncInjectStyle = (stylePath) => {
    const callback = cb || loader.async()
    loader.resolve(loader.context, stylePath, (err, result) => {
      if (err) {
        if (loader.mode === 'development') {
          console.log(`\nSKIPPING INJECTING STYLE ${stylePath} TO ${loader.resourcePath} WHICH NOT EXIST`, err)
        }
        return callback(null, source)
      }
      loader.addDependency(result)
      if (source.match(/export\s+{\s*default(\s+as\s+\w)?\s*}\s+from\s+['"][^'"]+['"]/)) {
        loader.emitWarning(new Error('the `export {default} from "xxx";` may cause handshake and lose style, you can use `import A from "xxx"; export default A;`'))
      }
      callback(null, injectStyle(source, stylePath))
    })
  }

  const isComponent = conf.componentRule && loader.resourcePath.match(conf.componentRule)
  if (isComponent) {
    asyncInjectStyle(conf.stylePath)
    return
  }

  return source
}

module.exports = function reactComponentLoader (source) {
  const options = getOptions(this)
  const isBaseStyleTarget = options.baseStyleTarget && this.resourcePath === options.baseStyleTarget

  optionsCached.baseStyleTarget = options.baseStyleTarget
  if (isBaseStyleTarget) {
    if (!optionsCached.components) {
      this.resolve.promise = promisify(this.resolve.bind(this))
      const callback = this.async()
      cacheOptions(this, this.context, options.components)
        .then(() => {
          optionsCached.baseStyles.forEach(style => this.addDependency(style))
          callback(null, injectStyle(source, optionsCached.baseStyles, true))
        })
    } else {
      optionsCached.baseStyles.forEach(style => this.addDependency(style))
      return injectStyle(source, optionsCached.baseStyles, true)
    }
  } else {
    if (!optionsCached.components) {
      this.resolve.promise = promisify(this.resolve.bind(this))
      const callback = this.async()
      cacheOptions(this, this.context, options.components)
        .then(() => {
          const src = processLoader(this, source, callback)
          // if processLoader is async, will return undefined
          if (src) {
            callback(null, src)
          }
        })
    } else {
      return processLoader(this, source)
    }
  }
}
