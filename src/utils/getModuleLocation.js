const {default: makeModuleTree, getAllPathsToModule, printModuleTree} = require('./getModulePath');
const filename_from_mod_id = require("./allowed_filename_from_mod_id");
const path = require('path');

var fileExt = null

function setFileExt(ext) {
  fileExt = ext
}

/**
 * function getModuleLocation would append '/index' or '/',  I will remove them if the file path ends with '.js'
 * @param appendTrailingIndexFilesToNodeModules
 * @param filePath
 * @returns {string}
 */
function rightTrimFilePathForJsExt(rootNodeModule,appendTrailingIndexFilesToNodeModules, filePath) {

  if (fileExt) {
    let indexSuffix = `${path.sep}index`
    let sepSuffix = `${path.sep}`

    let whichSuffix = !rootNodeModule?'': appendTrailingIndexFilesToNodeModules ? indexSuffix : sepSuffix

    if (filePath.endsWith(`${fileExt}${whichSuffix}`)) {
      filePath = filePath.substr(0, filePath.length - whichSuffix.length - fileExt.length)
    }
  }
  return filePath;
}

// Given a module, return it's location on disk.
function getModuleLocation(
    modules,
    mod,
    knownPaths = {},
    pathPrefix = "dist/",
    appendTrailingIndexFilesToNodeModules = false,
    entryPointModuleId = 1
) {


  pathPrefix = path.normalize(pathPrefix);
  let moduleHierarchy;
  let modulePaths = [];

  // Assemble a tree of modules starting at the entry point.
  let tree = makeModuleTree(modules, entryPointModuleId);
  // printModuleTree(tree);

  // If the module response contains a lookup table for modules that are required in by the current
  // module being iterated over, then calculate the hierachy of the requires to reconstruct the
  // tree.
  if (mod.lookup) {
    // Given a module, determine where it was imported within.
    console.log(`* Reconstructing require path for module ${mod.id}...`);

    let {completeEvents, incompleteEvents} = getAllPathsToModule(
        tree,
        mod.id,
        knownPaths
    );

    modulePaths = completeEvents;
  } else if (knownPaths[mod.id]) {
    // Use a known path if it exists.
    modulePaths = [[{id: mod.id, path: knownPaths[mod.id]}]];
  } else {
    // Final fallback - the name of the file is the module id.
    console.warn(`* No lookup tabie for module ${mod.id}, so using identifier as require path...`);
    modulePaths = [[{id: mod.id, path: `./${filename_from_mod_id(mod.id)}`}]];
  }

  /* ['./foo'] => './foo'
   * ['../foo'] => '../foo'
   * ['uuid', './foo'] => 'node_modules/uuid/foo'
   * ['uuid', './foo', './bar'] => 'node_modules/uuid/bar'
   * ['uuid', './bar/foo', './baz'] => 'node_modules/uuid/bar/baz'
   * ['abc', './foo', 'uuid', './bar'] => 'node_modules/uuid/bar'
   */

  let rootNodeModule = '';
  let requirePaths = modulePaths.map(modulePath => {
    return modulePath.reduce((acc, mod, ct) => {
      if (!mod.path.startsWith('.')) {
        // A root node module overrides the require tree, since paths are relative to it.
        rootNodeModule = mod.path;
        return [];
      } else if (ct === modulePath.length - 1) {
        // When we get to the last item, return the filename as part of the require path.
        return [...acc, mod.path || 'index'];
      } else {
        // A file import. However, this part is the directory only since further requires will
        // "stack" on top of this one. Therefore, the file that's being included is irrelevant until
        // the last item in the hierarchy (ie, the above case).
        return [...acc, path.dirname(mod.path)];
      }
    }, []);
  });

  // FIXME: currently just taking the first require path. Some smartness can be accomplished by
  // cross referencing between multiple require paths.
  let requirePath = requirePaths[0];

  if (requirePath && requirePath.length > 0) {
    modulePath = path.join(...requirePath);
  } else if (!rootNodeModule) {
    modulePath = 'index';
  } else {
    // If a root node module, then leave it empty. The root node module's index is implied.
    // Ie, you don't need to do `foo/index`, you can just do `foo`.
    modulePath = appendTrailingIndexFilesToNodeModules ? 'index' : '';
  }


  if (rootNodeModule) {
    modulePath = `node_modules/${rootNodeModule}/${modulePath}`;
  }

  // console.log(`* ${mod.id} => ${modulePath}`);

  let filePath = path.normalize(path.join(pathPrefix, modulePath));

  // If a filePath has a bunch of `../`s at the end, then it's broken (it broke out of the dist
  // folder!) In this cae, tell the user we need an absolute path of one of the files in order to
  // resolve it. Log out each of the paths along the require tree and it's respective module id.
  if (!filePath.startsWith(pathPrefix)) {
    let err = `${filePath}.startsWith(${pathPrefix})? WRONG.
    Don't have enough information to expand bundle into named files. The process requires the path of one of the below to be explicitly defined:`;
    // ${moduleHierarchy.map(([mod, stack]) => `- ${mod} (${stack.slice(-1)[0]})`).join('\n')}`;
    throw new Error(err);
  }
  filePath = rightTrimFilePathForJsExt(rootNodeModule,appendTrailingIndexFilesToNodeModules, filePath);
  console.log(`* ${mod.id} => ${filePath}`);

  return filePath;
}

function found_location(result) {
  return typeof (result) === 'string'
}

function get_relative_moduleLocation(node,this_mod, that_mod_name, modules, knownPaths, entryPointModuleId) {

  const that_mod = modules.find(i => i.id === that_mod_name);

  // FIXME:
  // In the spotify bundle someone did a require(null)? What is that supposed to do?
  if (!that_mod) {
    // throw new Error(`Module ${node.arguments[0].value} cannot be found, but another module (${mod.id}) requires it in.`);
    console.warn(`Module ${node.arguments[0].value} cannot be found, but another module (${this_mod.id}) requires it in.`);
    return node;
  }

  // This module's path
  let this_module_path = path.dirname(getModuleLocation(modules, this_mod, knownPaths, path.sep, /* appendTrailingIndexFilesToNodeModules */ true, entryPointModuleId));
  // The module to import relative to the current module
  let that_module_path = getModuleLocation(modules, that_mod, knownPaths, path.sep, /* appendTrailingIndexFilesToNodeModules */ false, entryPointModuleId);

  // Get a relative path from the current module to the module to require in.
  let moduleLocation = path.relative(
      this_module_path,
      that_module_path
  );

  // If the module path references a node_module, then remove the node_modules prefix
  if (moduleLocation.indexOf('node_modules/') !== -1) {
    moduleLocation = `${moduleLocation.match(/node_modules\/(.+)$/)[1]}`
  } else if (!moduleLocation.startsWith('.')) {
    // Make relative paths start with a ./
    moduleLocation = `./${moduleLocation}`;
  }

  return moduleLocation
}
function reverseObject(obj) {
  return Object.keys(obj).reduce((acc, i) => {
    acc[obj[i]] = i; // Reverse keys and values
    return acc;
  }, {});
}

module.exports = {setFileExt ,getModuleLocation,get_relative_moduleLocation, found_location};

if (require.main === module) {
  let modules = [
    {id: 1, code: null, lookup: {'./foo': 2, 'uuid': 3}},
    {id: 2, code: null, lookup: {'./bar/baz': 4}},
    {id: 3, code: null, lookup: {'./v1': 6, './v4': 7}},
    {id: 4, code: null, lookup: {'uuid': 3, '../hello': 5}},
    {id: 5, code: null, lookup: {}},

    {id: 6, code: null, lookup: {'./lib/rnd': 8}}, /* uuid/v1 */
    {id: 7, code: null, lookup: {'./lib/rnd': 8}}, /* uuid/v4 */
    {id: 8, code: null, lookup: {}}, /* uuid/lib/rnd */
  ];

  let output = getModuleLocation(modules, modules.find(i => i.id === 8), {1: './hello/world'});

  console.log(output);
}
