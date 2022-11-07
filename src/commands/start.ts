// Import types only from TS
type ErrorTrackingModule = typeof import('../error-tracking');
type IndexTypeModule = typeof import('../index');

// We accept auth tokens from the environment, allowing a token to be
// set without exposing it in the command line arguments.
const envToken = process.env.HTK_SERVER_TOKEN;
delete process.env.HTK_SERVER_TOKEN; // Don't let anything else see this

import * as path from 'path';
import { promises as fs } from 'fs'
import * as semver from 'semver';

import { IS_PROD_BUILD } from '../constants';

function maybeBundleImport<T>(moduleName: string): T {
    if (false) {
        // Full built package: load the bundle
        return require('../../bundle/' + moduleName);
    } else {
        // Npm or dev: run the raw code
        return require('../' + moduleName);
    }
}
const { initErrorTracking, reportError } = maybeBundleImport<ErrorTrackingModule>('error-tracking');
initErrorTracking();

import { Command, flags } from '@oclif/command'

const { runHTK } = maybeBundleImport<IndexTypeModule>('index');

class HttpToolkitServer extends Command {
    static description = 'start the HTTP Toolkit server'

    static flags = {
        version: flags.version({char: 'v'}),
        help: flags.help({char: 'h'}),

        config: flags.string({char: 'c', description: 'optional path in which to store config files'}),
        token: flags.string({char: 't', description: 'optional token to authenticate local server access'}),
    }

    async run() {
        const { flags } = this.parse(HttpToolkitServer);

        this.cleanupOldServers(); // Async cleanup old server versions

        await runHTK({
            configPath: flags.config,
            authToken: envToken || flags.token
        }).catch(async (error) => {
            await reportError(error);
            throw error;
        });
    }

    // On startup, we want to kill any downloaded servers that are not longer necessary
    async cleanupOldServers() {
        if (!fs) return; // In node 8, fs.promises doesn't exist, so just skip this

        const { dataDir, version: currentVersion } = this.config;

        const serverUpdatesPath = process.env.OCLIF_CLIENT_HOME ||
            path.join(dataDir, 'client');

        // Be careful - if the server path isn't clearly ours somehow, ignore it.
        if (!isOwnedPath(serverUpdatesPath)) {
            reportError(`Unexpected server updates path (${serverUpdatesPath}), ignoring`);
            return;
        }

        const serverPaths= await fs.readdir(serverUpdatesPath)
            .catch((e) => {
                if (e.code === 'ENOENT') return null;
                else throw e;
            });
        if (!serverPaths) return; // No server update path means we're all good

        // Similarly, if the folder contains anything unexpected, be careful and do nothing.
        if (serverPaths.some((filename) =>
            !semver.valid(filename.replace(/\.partial\.\d+$/, '')) &&
            filename !== 'bin' &&
            filename !== 'current' &&
            filename !== '.DS_Store' // Meaningless Mac folder metadata
        )) {
            console.log(serverPaths);
            reportError(
                `Server path (${serverUpdatesPath}) contains unexpected content, ignoring`
            );
            return;
        }

        const maybeReportError = (error: Error & { code?: string }) => {
            if ([
                'EBUSY',
                'EPERM'
            ].includes(error.code!)) return;

            else reportError(error);
        };

        if (serverPaths.every((filename) => {
            const version = semver.valid(filename.replace(/\.partial\.\d+$/, ''));
            return !version || semver.lt(version, currentVersion);
        })) {
            // If everything is outdated, just drop the whole folder. Useful if you start
            // a new server standalone (not just from an update), because otherwise the
            // update dir can end up in a broken state. Better to clear it completely.
            console.log("Downloaded server directory is entirely outdated, deleting it");
            deleteFolder(serverUpdatesPath).catch(maybeReportError);
        } else {
            // Some of the servers are outdated, but not all (maybe it includes us).
            // Async delete all server versions older than this currently running version.
            serverPaths.forEach((filename) => {
                const version = semver.valid(filename.replace(/\.partial\.\d+$/, ''));

                if (version && semver.lt(version, currentVersion)) {
                    console.log(`Deleting old server ${filename}`);
                    deleteFolder(path.join(serverUpdatesPath, filename)).catch(maybeReportError);
                }
            });
        }
    }
}

// Delete a folder recursively, with checks to ensure its safe to do so at every stage
async function deleteFolder(folder: string) {
    const contents: string[] = await fs.readdir(folder)
        .catch((e) => {
            if (e.code === 'ENOENT') return [];
            else throw e;
        });

    await Promise.all(
        contents.map(async (filename) => {
            const filePath = path.join(folder, filename);
            if ((await fs.lstat(filePath)).isDirectory()) {
                await deleteFolder(filePath); // Recurse
            } else if (isOwnedPath(filePath)) {
                await fs.unlink(filePath);
            }
        })
    );

    if (isOwnedPath(folder)) await fs.rmdir(folder);
};

// Before deleting anything anywhere, we check it's an HTK-related path.
// Not a perfect check, but good safety against somehow deleting / or similar.
function isOwnedPath(input: string) {
    if (input.split(path.sep).includes('httptoolkit-server')) {
        return true;
    } else {
        reportError(`Unexpected unowned path ${input}`);
        return false;
    }
}

export = HttpToolkitServer;
