const path = require('path');

const replace = require('./extern/replace-method');

const _getModuleLocation = require('./utils/getModuleLocation');
const get_relative_moduleLocation = _getModuleLocation.get_relative_moduleLocation
const found_location = _getModuleLocation.found_location

var inlineOrVariable = require('./utils/inlineOrVariable');
var should_replace = inlineOrVariable.should_replace;
var should_add_var = inlineOrVariable.should_add_var;

// only for debugging in WebStrom watch
var recast = require('recast');
var parse = recast.parse;
var print = recast.print;

// Transform require calls to match the path of a given file.
// Here's the problem this transformation solves. Say I've got a file `foo` and a file `bar`, and
// they are in seperate directories. `foo` requires `bar`. The require path to bar in `foo` needs to
// reflect the fact that they are in different places and not necisarily in a flat directory
// structure. This transform reads require calls and adjusts the AST to point to the path to the
// module on disk.
//
// Takes an array of modules in [{id: 1, code: (ast), lookup: {}}] format, and returns the same
// format only with the ast of each module adjusted to refrence other modules properly.
//
// Also takes an optional argument `knownPaths`, which is a key value mapping where key is a module
// id and the value is the patht to that module. No `.js` needed. Ie, {1: '/path/to/my/module'}
function transformRequires(
    modules,
    config
) {

    return modules.map(mod => {
        let moduleDescriptor = mod.code.body;

        // Make sure the code is at its root a function.
        if (mod && mod.code && !(mod.code.type == 'FunctionDeclaration' || mod.code.type === 'FunctionExpression')) {
            console.warn(`* WARNING: Module ${mod.id} doesn't have a function at its root.`);
            return mod;
        }

        if (!(mod.code && mod.code.params && mod.code.params.length > 0)) {
            console.log(`* Module ${mod.id} has no require param, skipping...`);
            return mod;
        }


        // Determine the name of the require function. In unminified bundles it's `__webpack_require__`.
        let requireFunctionIdentifier = mod.code.params[config.type === 'webpack' ? 2 : 0];

        var find_target_and_implement_updater = replace(mod.code, config)

        // source = 'var s=3;';
        // console.log(print(parse(source)).code);

        // Adjust the require calls to point to the files, not just the numerical module ids.
        // Unlike the below transforms, we always want this one no matter the name of the require
        // function to run since we're doning more than just changing the require functon name.
        if (requireFunctionIdentifier) {
            replace_requires(mod, modules, requireFunctionIdentifier, config, find_target_and_implement_updater)
            //  to implement "replaceRequires": "variable",
            add_variable(config, 'replaceRequires', requireFunctionIdentifier, mod, 'require')
        }

        // Also, make sure that the `module` that was injected into the closure sorrounding the module
        // wasn't mangled, and if it was, then update the closure contents to use `module` not the
        // mangled variable.
        let moduleIdentifier = mod.code.params[config.type === 'webpack' ? 0 : 1];
        if (moduleIdentifier && moduleIdentifier.name !== 'module') {
            if (should_replace(config.replaceModules)) {
                console.log(`* Replacing ${moduleIdentifier.name} with 'module'...`);
                find_target_and_implement_updater(
                    moduleIdentifier.name,
                    node => {
                        node.name = 'module';
                        return node;
                    }
                );
            }
            //  to implement "replaceModules": "variable",
            add_variable(config, 'replaceModules', moduleIdentifier, mod, 'module')
        }

        // for `exports`
        let exportsIdentifier = mod.code.params[config.type === 'webpack' ? 1 : 2];
        if (exportsIdentifier && exportsIdentifier.name !== 'exports') {
            if (should_replace(config.replaceExports)) {
                console.log(`* Replacing ${exportsIdentifier.name} with 'exports'...`);
                find_target_and_implement_updater(
                    exportsIdentifier.name,
                    node => {
                        node.name = 'exports';
                        return node;
                    }
                );
            }
            //  to implement "replaceExports": "variable",
            add_variable(config, 'replaceExports', exportsIdentifier, mod, 'exports')
        }


        for (let obj of config.visitor_objects) {
            obj(mod.code, config)
        }


        return mod;
    });
}

/**
 * Prepend some ast that aliases the minified require/module/exports variable to `require` 'module' or 'exports'
 * if them hasn't been replaced inline in the code.
 *
 * @param identifier
 * @param mod
 * @param name 'require', 'module' or 'exports'
 *
 */
function add_variable(config, configItem, identifier, mod, name) {
    if (
        should_add_var(config[configItem]) &&
        identifier.name !== name &&
        mod.code && mod.code.body && mod.code.body.body
    ) {
        // At the top of the module closure, set up an alias to the module identifier.
        // ie, `const t = module;`
        console.log(`* Aliasing ${identifier.name} with '${name}'...`);
        mod.code.body.body.unshift(
            build_VariableAssignment(identifier, {type: 'Identifier', name: name},config.variableType)
        );

    }
}


function replace_requires(mod, modules, requireFunctionIdentifier, config, find_target_and_implement_updater) {

    var knownPaths = config.knownPaths, entryPointModuleId = config.entryPoint,
        replaceRequires = config.replaceRequires || 'inline';

    find_target_and_implement_updater(
        requireFunctionIdentifier.name,
        _replaer_requires
    );


    function _replaer_requires(node, node_path) {


        // only for debugging in WebStrom watch
        print = print

        // the worth of node_path:
        //      in require_visitors, _replaer_requires is called with paraeter path, stopping the probability of indefinet loop
        if (node_path) {
            var node_throught_require_visitors = node_path, result_from_require_visitor, node_updated = false;
            for (let obj of config.require_visitor_objects) {
                result_from_require_visitor = obj(
                    mod,  modules, knownPaths, entryPointModuleId,
                    node_throught_require_visitors, _replaer_requires, update_RequireVar,should_replace, replaceRequires, requireFunctionIdentifier)
                if (result_from_require_visitor && result_from_require_visitor.scil_debundle) {
                    node_throught_require_visitors = result_from_require_visitor
                    node_updated = true;
                }
            }
            // return the node returned from visitors, or go on to let node not handlded by require_visitors any more
            if (node_updated) return node_throught_require_visitors;
        }

        switch (node.type) {
            case 'CallExpression':
                // If require is called bare (why would this ever happen? IDK, it did in a bundle
                // once), then return AST without any arguments.
                if (node.arguments.length === 0) {
                    return {
                        type: 'CallExpression',
                        // If replacing all require calls in the ast with the identifier `require`, use
                        // that identifier (`require`). Otherwise, keep it the same.
                        callee: should_replace(replaceRequires) ? {
                            type: 'Identifier',
                            name: 'require',
                        } : requireFunctionIdentifier,
                        arguments: [],
                    };
                }

                if (node.hasOwnProperty('sameNameArgument')) {
                    return update_Argument(node, replaceRequires, requireFunctionIdentifier)
                }

                // case: n.n(x)
                if (node.callee.type == 'MemberExpression') {
                    return update_MemberExpression(node, replaceRequires, requireFunctionIdentifier);
                }

                // case: n(1)
                // If a module id is in the require, then do the require.
                if (node.arguments[0].type === 'Literal') {
                    var moduleNameToRequire = node.arguments[0].value;
                    var moduleLocationOrOriginalNode = get_relative_moduleLocation(node,mod, moduleNameToRequire, modules, knownPaths, entryPointModuleId)
                    if(!found_location(moduleLocationOrOriginalNode)) return moduleLocationOrOriginalNode;

                    return {
                        type: 'CallExpression',
                        // If replacing all require calls in the ast with the identifier `require`, use
                        // that identifier (`require`). Otherwise, keep it the same.
                        callee: should_replace(replaceRequires) ? {
                            type: 'Identifier',
                            name: 'require',
                        } : requireFunctionIdentifier,
                        arguments: [
                            // Substitute in the module location on disk
                            {type: 'Literal', value: moduleLocationOrOriginalNode, raw: moduleLocationOrOriginalNode},
                            ...node.arguments.slice(1),
                        ],
                    };
                } else if (node.arguments[0].type === 'Identifier') {
                    if (should_replace(replaceRequires)) {
                        // If replacing the require symbol inline, then replace with the identifier `require`
                        return {
                            type: 'CallExpression',
                            callee: {
                                type: 'Identifier',
                                name: 'require',
                            },
                            arguments: node.arguments,
                        };
                    } else {
                        // Otherwise, just pass through the AST.
                        return node;
                    }
                }

            case 'Identifier':
                return should_replace(replaceRequires) ? {
                    type: 'Identifier',
                    name: 'require',
                } : requireFunctionIdentifier;
        }


    }


}


function build_VariableAssignment(variableIdentifier, contentIdentifier, type) {
    return {
        "type": "VariableDeclaration",
        "declarations": [
            {
                "type": "VariableDeclarator",
                "id": variableIdentifier,
                "init": contentIdentifier,
            },
        ],
        "kind": type,
    };
}

function update_RequireVar(replaceRequires, requireFunctionIdentifier) {
    return should_replace(replaceRequires) ? {
        type: 'Identifier',
        name: 'require',
    } : requireFunctionIdentifier
}

function update_MemberExpression(node, replaceRequires, requireFunctionIdentifier) {
    if (should_replace(replaceRequires)) {
        node = {
            "type": "CallExpression",
            "callee": {
                "type": "MemberExpression",
                "object": update_RequireVar(replaceRequires, requireFunctionIdentifier),
                "property": node.callee.property,
            },
            "arguments": node.arguments
        }
    }

    return node;
}

function update_Argument(node, replaceRequires, requireFunctionIdentifier) {
    if (should_replace(replaceRequires)) {
        var arguments = node.arguments.map((a) => {
            if (a.name == requireFunctionIdentifier.name)
                return update_RequireVar(replaceRequires, requireFunctionIdentifier)
            else
                return a
        })

        node = {
            "type": 'CallExpression',
            "callee": node.callee,
            "arguments": arguments
        }
    }
    return node;

}

module.exports = transformRequires;
