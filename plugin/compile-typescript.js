var fs = Npm.require('fs');
var path = Npm.require('path');
var _ = Npm.require('underscore');
var Future = Npm.require('fibers/future');
var typescript = Npm.require('typescript.api');

var stripExportedVars = function(source, exports) {
	if (!exports || _.isEmpty(exports))
		return source;
	var lines = source.split("\n");

	// We make the following assumptions, based on the output of CoffeeScript
	// 1.6.3.
	//   - The var declaration in question is not indented and is the first such
	//     var declaration.  (CoffeeScript only produces one var line at each
	//     scope and there's only one top-level scope.)  All relevant variables
	//     are actually on this line.
	//   - The user hasn't used a ###-comment containing a line that looks like
	//     a var line, to produce something like
	//        /* bla
	//        var foo;
	//        */
	//     before an actual var line.  (ie, we do NOT attempt to figure out if
	//     we're inside a /**/ comment, which is produced by ### comments.)
	//   - The var in question is not assigned to in the declaration, nor are any
	//     other vars on this line. (CoffeeScript does produce some assignments
	//     but only for internal helpers generated by CoffeeScript, and they end
	//     up on subsequent lines.)
	// XXX relax these assumptions by doing actual JS parsing (eg with jsparse).
	//     I'd do this now, but there's no easy way to "unparse" a jsparse AST.
	//     Or alternatively, hack the compiler to allow us to specify unbound
	//     symbols directly.

	for (var i = 0 ; i < lines.length ; i++) {
		var line = lines[i];
		var match = /^var (.+)([,;])$/.exec(line);
		if (!match)
			continue;

		// If there's an assignment on this line, we assume that there are ONLY
		// assignments and that the var we are looking for is not declared. (Part
		// of our strong assumption about the layout of this code.)
		if (match[1].indexOf('=') !== -1)
			continue;

		// We want to replace the line with something no shorter, so that all
		// records in the source map continue to point at valid
		// characters.
		var replaceLine = function(x) {
			if (x.length >= lines[i].length) {
				lines[i] = x;
			} else {
				lines[i] = x + new Array(1 + (lines[i].length - x.length)).join(' ');
			}
		};

		var vars = match[1].split(', ');
		vars = _.difference(vars, exports);
		if (!_.isEmpty(vars)) {
			replaceLine("var " + vars.join(', ') + match[2]);
		} else {
			// We got rid of all the vars on this line. Drop the whole line if this
			// didn't continue to the next line, otherwise keep just the 'var '.
			if (match[2] === ';')
				replaceLine('');
			else
				replaceLine('var');
		}
		break;
	}

	return lines.join('\n');
};

// show diagnostic errors.
var getDiagnostics = function(units) {

	var err = "";
	for (var n in units) {

		for (var m in units[n].diagnostics) {

			err = err + units[n].diagnostics[m].toString() + '\n\r';
		}
	}
	return err;
};

var endsWith = function(str, ends) {
	if (str == null) return false;
	return str.length >= ends.length && str.slice(str.length - ends.length) === ends;
};

function compile(compileStep) {

	var future = new Future;

	var jsVersion = "EcmaScript5";
	if (compileStep.archMatches("browser")) {
		jsVersion = "EcmaScript3";
	}

	typescript.reset({
		languageVersion: jsVersion,
		removeComments: true,
		mapSourceFiles: true
	});

	typescript.resolve([compileStep._fullInputPath], function(resolvedArray) {

		if (!typescript.check(resolvedArray))
			throw new Error(getDiagnostics(resolvedArray));

		else {

			typescript.compile(resolvedArray, function(compiledUnit) {

				if (!typescript.check(compiledUnit))
					throw new Error(getDiagnostics(compiledUnit));

				else {

					var sourceJS = compiledUnit[0].content;

					// Some ts files (especially .d.ts files) may compile to an empty string
					if (sourceJS && sourceJS.length > 0) {

						// Strip generated sourceMappingURL line (meteor will add its own).
						// Doing this probably affects the actual source mapping, but this line is near
						// the end so hopefully it won't matter much.
						sourceJS = sourceJS.replace(/\/\/# sourceMappingURL/, '// IGNORING THIS:   ');

						var strippedJS = stripExportedVars(sourceJS, compileStep.declaredExports);
						var filename = compileStep.inputPath;

						var sourceMap = JSON.parse(compiledUnit[0].sourcemap);
						var source = compileStep.read().toString('utf8');
						sourceMap.sourcesContent = [source];
						var dummyNames = [];
						for (var i = 0; i < sourceMap.names.length; i++) { dummyNames.push('_dummyName' + i); }
						sourceMap.names = sourceMap.names.concat(dummyNames);

						compileStep.addJavaScript({
							path: filename + ".js",
							sourcePath: filename,
							data: strippedJS,
							sourceMap: JSON.stringify(sourceMap)
						});
					}

					return future.return(true);
				}
			});
		}
	});

	return future;
}

var handler = function(compileStep) {

	var filename = compileStep.inputPath;

	if (!endsWith(filename, ".d.ts")) {
		compile(compileStep).wait();
	}
};

Plugin.registerSourceHandler("ts", handler);
