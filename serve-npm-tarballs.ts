import * as yargs from 'yargs';
import * as childProcess from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { promises as fs } from 'fs';

// No types :(
const { default: startVerdaccio } = require('verdaccio');

async function main() {
  const argv = yargs
    .usage('$0 [options] [COMMAND [...]]')
    .option('verbose', {
      alias: 'v',
      type: 'boolean',
      desc: 'Increase logging verbosity',
      count: true,
      default: 0
    })
    .option('directory', {
      alias: 'd',
      type: 'string',
      requiresArg: true,
      desc: 'Serve all *.tgz files from the given directory',
      default: '.',
    })
    .option('log', {
      alias: 'l',
      type: 'string',
      requiresArg: true,
      desc: 'Write logs to the given file',
    })
    .option('port', {
      alias: 'p',
      type: 'number',
      requiresArg: true,
      desc: 'Port number to serve on',
      default: 4873
    })
    .option('log-level', {
      alias: 'L',
      type: 'string',
      requiresArg: true,
      desc: 'Log level to log to file with',
      default: 'info'
    })
    .option('hide-upstream', {
      alias: 'H',
      type: 'string',
      array: true,
      requiresArg: true,
      default: [],
      nargs: 1,
      desc: 'Hide upstream packages matching this filename mask (may be repeated)',
    })
    .option('hide-tarballs', {
      alias: 'h',
      type: 'boolean',
      desc: 'Hide all packages found in *.tgz in the --directory from upstream (hides all versions)',
    })
    .option('daemon', {
      alias: 'D',
      type: 'boolean',
      desc: 'Run as a daemon. Output environment variables to interace with the daemon on stdout, ready to be eval\'ed',
    })
    .help()
    .strict()
    .version()
    .showHelpOnFail(false)
    .argv;

  if (argv._.length === 0 && !argv.daemon) {
    throw new Error(`Usage: serve-npm-tarballs COMMAND, or use --daemon`);
  }
  if (argv._.length > 0 && argv.daemon) {
    throw new Error(`Give either a COMMAND, or specify --daemon, but not both.`);
  }

  if (argv.daemon) {
    if (process.send) {
      // Child process
      await runWithServer(async (npmConfigEnv) => {
        const bashExports = Object.entries(npmConfigEnv)
          .map(([key, value]) => `export ${key}=${value}`)
          .join('\n');

        process.send!(bashExports);

        debug('Waiting for SIGINT, SIGTERM, SIGUSR1');

        await Promise.race([
          new Promise(ok => process.on('SIGINT', ok)),
          new Promise(ok => process.on('SIGTERM', ok)),
          new Promise(ok => process.on('SIGUSR1', ok)),
        ]);

        debug('Shutting down.');
      });
    } else {
      const daemonProc = childProcess.fork(path.resolve(__filename), process.argv.slice(2), {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      // Wait for the first message, print that to stdout, then exit
      const childMessage: string = await new Promise(ok => daemonProc.on('message', ok));
      process.stdout.write(childMessage + '\n');

      // Don't wait for the child proc anymore
      daemonProc.disconnect();
      daemonProc.unref();
    }
  } else {
    // Not in daemon mode
    await runWithServer(async (npmConfigEnv) => {
      // Disable SIGINT handling just before starting the subprocess, so the subprocess
      // completely gets to decide what to do with Ctrl-C.
      process.on('SIGINT', () => undefined);

      await invokeSubprocess(argv._, {
        verbose: argv.verbose > 0,
        env: {...process.env, ...npmConfigEnv},
      });

      debug('Subprocess finished');
    });
  }

  async function runWithServer(action: (subprocessEnv: Record<string, string>) => Promise<void>) {
    if (!argv.verbose) {
      debug = () => undefined;
    }

    const port = argv.port;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-npm-tarballs-'));
    try {
      debug(`Working directory: ${tempDir}`);

      const tarballs = (await fs.readdir(argv.directory, { encoding: 'utf-8' }))
        .filter(f => f.endsWith('.tgz'))
        .map(f => path.resolve(argv.directory, f));

      const packagesToHide: string[] = [...argv["hide-upstream"]];
      if (argv["hide-tarballs"]) {
        // We have to read the package name from every individual tarball
        for (const tarball of tarballs) {
          try {
            const pj = JSON.parse((await extractFileFromTarball(tarball, 'package/package.json')).toString());
            packagesToHide.push(pj.name as any);
          } catch (e) {
            debug(`Error reading ${tarball}'s package.json: ${e.message}`);
          }
          tar.x({ file: tarball }, ['package/package.json']);
        }
      }

      const packageHidingConfig: any = {};
      debug(`Hiding ${packagesToHide}`);
      for (const mask of packagesToHide) {
        packageHidingConfig[mask] = {
          access: '$all',
          publish: '$all',
          // Specifically: no 'proxy' directive!
        };
      }

      const configJson = {
        storage: tempDir,
        uplinks: {
          npmjs: {
            url: 'https://registry.npmjs.org',
            cache: false
          }
        },
        max_body_size: '100mb',
        publish: {
          allow_offline: true
        },
        logs: [
          ...argv.log ? [{ type: 'file', path: argv.log, format: 'pretty', level: argv["log-level"] }] : [],
          ...argv.verbose ? [{ type: 'stderr', format: 'pretty', level: argv["log-level"] }] : [],
        ],
        packages: {
          ...packageHidingConfig,
          '**': {
            access: '$all',
            publish: '$all',
            proxy: 'npmjs',
          }
        },
      };

      // Write a config file for NPM
      // The auth token MUST be passed via .npmrc: https://github.com/npm/npm/issues/15565
      await fs.writeFile(path.join(tempDir, '.npmrc'), [
        `//localhost:${port}/:_authToken=none`,
        '',
      ].join('\n'), { encoding: 'utf-8' });

      const npmConfigVars = {
        // NPM should find the auth token here
        npm_config_userconfig: path.join(tempDir, '.npmrc'),

        // Pass registry via environment variable, so that if this script gets run via 'npm run'
        // and all $npm_config_xxx settings are passed via environment variables, we still
        // get to override it (the file would normally be ignored in that case).
        npm_config_registry: `http://localhost:${port}/`,

        // The PID which a script can use to kill us
        SERVE_NPM_TARBALLS_PID: `${process.pid}`
      };

      const subprocessEnv = {
        ...process.env,
        ...npmConfigVars,
      };

      await new Promise(ok => startVerdaccio(configJson, port, tempDir, '0.1.0', 'serve-npm-tarballs+verdaccio', (webServer: any, addr: any, _pkgName: any, _pkgVersion: any) => {
        debug(`Listening on ${addr.host}:${addr.port}`);
        webServer.listen(addr.port || addr.path, addr.host, async () => {
          try {
            // Publish all tarballs
            await Promise.all(tarballs.map(async (tarball) => invokeSubprocess(['npm', '--loglevel', 'silent', 'publish', tarball], {
              verbose: argv.verbose > 0,
              env: subprocessEnv,
            })));

            await action(npmConfigVars);
          } catch (e) {
            console.error(e.message);
            process.exitCode = 1;
          }

          webServer.close();
          ok();
        });
      }));
    } finally {
      await fs.rmdir(tempDir, { recursive: true });
    }
  }
}

let debug = (message: string) => {
  console.error('>', message);
};

interface ShellOptions extends childProcess.SpawnOptions {
  verbose?: boolean;
}

async function invokeSubprocess(command: string[], options: ShellOptions = {}): Promise<string> {
  if (options.verbose) {
    debug(`Executing '${command.join(' ')}'`);
  }
  const child = childProcess.spawn(command[0], command.slice(1), {
    ...options,
    stdio: 'inherit',
  });

  return new Promise<string>((resolve, reject) => {
    child.once('error', reject);

    child.once('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command '${command}' exited with error code ${code}`));
      }
    });
  });
}

async function extractFileFromTarball(tarball: string, filePath: string): Promise<Buffer> {
  const data = new Array<Buffer>();
  await tar.t({
    file: tarball,
    onentry: entry => {
      if (entry.path as unknown as string === filePath) {
        entry.on('data', c => data.push(c));
      }
    }
  });

  return Buffer.concat(data);
}


main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});