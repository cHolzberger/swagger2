// compiler.js

/*
 * Convert a swagger document into a compiled form so that it can be used by validator
 */

/*
 The MIT License

 Copyright (c) 2014-2016 Carl Ansley

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 */

const path = require("path");
import * as jsonValidator from 'is-my-json-valid';
import deref = require('json-schema-deref');
import * as YAML from 'yamljs';

import {CollectionFormat, Definition, Document, Parameter, PathItem} from './schema';

export interface Compiled {
  (path: string): CompiledPath | undefined;
}

export interface CompiledDefinition extends Definition {
  validator: (value: any) => boolean;
}

export interface CompiledParameter extends Parameter {
  validator: (value: any) => boolean;
}

export interface CompiledPath {
  regex: RegExp;
  path: PathItem;
  name: string;
  expected: string[];
}

/*
 * A wrapper for async deref
 */

async function derefp(document: any, options?: any): Promise<any> {
  let p = new Promise<any> ((resolve, reject) => {
    deref(document, options, (err: any, derefedDocument: any) => {
      if ( err ) {
        reject(err);
      } else {
        resolve(derefedDocument);
      }
    });
  });
  return p;
}

/*
 * We need special handling for query validation, since they're all strings.
 * e.g. we must treat "5" as a valid number
 */
function stringValidator(schema: any) {
  let validator = jsonValidator(schema);
  return (value: any) => {

    // if an optional field is not provided, we're all good other not so much
    if (value === undefined) {
      return !schema.required;
    }

    switch (schema.type) {
      case 'number':
      case 'integer':
        if (!isNaN(value)) {
          // if the value is a number, make sure it's a number
          value = +value;
        }
        break;

      case 'boolean':
        if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          const format: CollectionFormat = schema.collectionFormat || 'csv';
          switch (format) {
            case 'csv':
              value = String(value).split(',');
              break;
            case 'ssv':
              value = String(value).split(' ');
              break;
            case 'tsv':
              value = String(value).split('\t');
              break;
            case 'pipes':
              value = String(value).split('|');
              break;
            case 'multi':
            default:
              value = [value];
              break;
          }
        }
        switch (schema.items.type) {
          case 'number':
          case 'integer':
            value = value.map((num: any) => {
              if (!isNaN(num)) {
                // if the value is a number, make sure it's a number
                return +num;
              } else {
                return num;
              }
            });
            break;
          case 'boolean':
            value = value.map((bool: any) => {
              if (bool === 'true') {
                return true;
              } else if (bool === 'false') {
                return false;
              } else {
                return bool;
              }
            });
            break;
          default:
          // leave as-is
        }
        break;

      default:
        // leave as-is
    }
    return validator(value);
  };
}


async function ymlLoader(ref:string, option:any, fn:any) {
  console.log(ref);
  if ( ref.toLowerCase().endsWith(".yml") || ref.toLowerCase().endsWith(".yaml")  ) {
    console.log(option.baseFolder);
    var yamlRef = YAML.load(path.join(option.baseFolder, ref));

    let derefOptions = {
      failOnMissing: option.failOnMissing,
      loader: ymlLoader,
      baseFolder: path.dirname(path.join(option.baseFolder, ref))
    }

    let resolved = await derefp(yamlRef, derefOptions);
    return fn(null, resolved);
  }
  return fn();
}

export async function compile(document: Document, baseFolder?: string): Promise<Compiled> {
  let derefOptions:any = {
    failOnMissing: false,
    baseFolder: baseFolder,
    loader: ymlLoader
  };

    // get the de-referenced version of the swagger document
  let swagger = await derefp(document, derefOptions);

  // add a validator for every parameter in swagger document
  Object.keys(swagger.paths).forEach(pathName => {
    let path = swagger.paths[pathName];
    Object.keys(path).forEach(operationName => {
      let operation = path[operationName];
      (operation.parameters || []).forEach((parameter: CompiledParameter) => {
        let schema = parameter.schema || parameter;
        if (parameter.in === 'query' || parameter.in === 'header') {
          parameter.validator = stringValidator(schema);
        } else {
          parameter.validator = jsonValidator(schema);
        }
      });
      Object.keys(operation.responses).forEach(statusCode => {
        let response = operation.responses[statusCode];
        if (response.schema) {
          response.validator = jsonValidator(response.schema);
        } else {
          // no schema, so ensure there is no response
          // tslint:disable-next-line:no-null-keyword
          response.validator = (body: any) => body === undefined || body === null || body === '';
        }
      });
    });
  });

  let matcher: CompiledPath[] = Object.keys(swagger.paths)
    .map(name => {
      return {
        name,
        path: swagger.paths[name],
        regex: new RegExp(swagger.basePath + name.replace(/\{[^}]*}/g, '[^/]+') + '$'),
        expected: (name.match(/[^\/]+/g) || []).map(s => s.toString())
      };
    });

  return (path: string) => {
    // get a list of matching paths, there should be only one
    let matches = matcher.filter(match => !!path.match(match.regex));
    if (matches.length !== 1) {
      return;
    }
    return matches[0];
  };

}
