import {
    Uri,
    workspace,
    window,
    commands,
    ViewColumn,
    TextDocument,
    TextDocumentShowOptions,
} from 'vscode';
import * as sinon from 'sinon';
import { FossilCWD, Reason } from '../../fossilExecutable';
import {
    assertGroups,
    cleanupFossil,
    fakeExecutionResult,
    fakeFossilStatus,
    getExecStub,
    getExecutable,
    getRepository,
} from './common';
import * as assert from 'assert/strict';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { Suite, before } from 'mocha';
import {
    FossilCommitMessage,
    RelativePath,
    ResourceStatus,
} from '../../openedRepository';
import { FossilResource } from '../../repository';

async function documentWasShown(
    sandbox: sinon.SinonSandbox,
    urlMatch: string | sinon.SinonMatcher,
    showMatch: any[],
    body: () => Thenable<void>
) {
    const openTextDocument = sandbox.stub(
        workspace,
        'openTextDocument'
    ) as sinon.SinonStub;
    openTextDocument.resolves(42);

    const showTextDocument = (
        sandbox.stub(window, 'showTextDocument') as sinon.SinonStub
    ).resolves();

    await body();

    sinon.assert.calledOnceWithExactly(openTextDocument, urlMatch);
    sinon.assert.calledOnceWithExactly(showTextDocument, 42, ...showMatch);

    openTextDocument.restore();
    showTextDocument.restore();
}

export function resourceActionsSuite(this: Suite): void {
    let rootUri: Uri;

    before(() => {
        rootUri = workspace.workspaceFolders![0].uri;
    });

    test('fossil add nothing', async () => {
        await commands.executeCommand('fossil.add');
    });

    test('fossil add', async () => {
        const uri = Uri.joinPath(rootUri, 'add.txt');
        await fs.writeFile(uri.fsPath, 'fossil_add');

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uri);
        assert.ok(resource);

        await commands.executeCommand('fossil.add', resource);
        await repository.updateStatus('Test' as Reason);
        assert.ok(!repository.untrackedGroup.includesUri(uri));
        assert.ok(repository.stagingGroup.includesUri(uri));
    }).timeout(5000);

    test('fossil add untracked', async () => {
        let execStub = getExecStub(this.ctx.sandbox);
        let statusStub = fakeFossilStatus(execStub, 'EXTRA a.txt\nEXTRA b.txt');

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            untracked: [
                [Uri.joinPath(rootUri, 'a.txt').fsPath, ResourceStatus.EXTRA],
                [Uri.joinPath(rootUri, 'b.txt').fsPath, ResourceStatus.EXTRA],
            ],
        });
        execStub.restore();
        execStub = getExecStub(this.ctx.sandbox);
        statusStub = fakeFossilStatus(execStub, 'ADDED a.txt\nADDED b.txt');
        const addStub = execStub
            .withArgs(sinon.match.array.startsWith(['add']))
            .resolves();
        await commands.executeCommand('fossil.addAll');
        sinon.assert.calledOnce(statusStub);
        sinon.assert.calledOnceWithExactly(addStub, [
            'add',
            '--',
            'a.txt' as RelativePath,
            'b.txt' as RelativePath,
        ]);
        assertGroups(repository, {
            staging: [
                [Uri.joinPath(rootUri, 'a.txt').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b.txt').fsPath, ResourceStatus.ADDED],
            ],
        });
    });

    test('fossil add untracked does not add working group', async () => {
        const repository = getRepository();
        await cleanupFossil(repository);
        const execStub = getExecStub(this.ctx.sandbox);
        const statusStub = fakeFossilStatus(execStub, 'ADDED a\nADDED b');
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            working: [
                [Uri.joinPath(rootUri, 'a').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b').fsPath, ResourceStatus.ADDED],
            ],
        });
        await commands.executeCommand('fossil.addAll');
        sinon.assert.calledOnce(statusStub);
        assertGroups(repository, {
            working: [
                [Uri.joinPath(rootUri, 'a').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b').fsPath, ResourceStatus.ADDED],
            ],
        });
    });

    test('fossil forget', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        const forgetCallStub = execStub
            .withArgs(sinon.match.array.startsWith(['forget']))
            .resolves();
        fakeFossilStatus(execStub, 'ADDED a.txt\nEDITED b.txt\nEXTRA c.txt');
        await repository.updateStatus('Test' as Reason);
        await commands.executeCommand(
            'fossil.forget',
            ...repository.workingGroup.resourceStates
        );
        sinon.assert.calledOnceWithMatch(forgetCallStub, [
            'forget',
            '--',
            'a.txt',
            'b.txt',
        ]);

        // better branch coverage
        await commands.executeCommand('fossil.forget');
        assertGroups(repository, {
            working: [
                [Uri.joinPath(rootUri, 'a.txt').fsPath, ResourceStatus.ADDED],
                [
                    Uri.joinPath(rootUri, 'b.txt').fsPath,
                    ResourceStatus.MODIFIED,
                ],
            ],
            untracked: [
                [Uri.joinPath(rootUri, 'c.txt').fsPath, ResourceStatus.EXTRA],
            ],
        });
        await commands.executeCommand(
            'fossil.forget',
            ...repository.untrackedGroup.resourceStates
        );
    }).timeout(5000);

    test('Ignore', async () => {
        const uriToIgnore = Uri.joinPath(rootUri, 'autogenerated');
        const urlIgnoredGlob = Uri.joinPath(
            rootUri,
            '.fossil-settings',
            'ignore-glob'
        );
        await fs.writeFile(uriToIgnore.fsPath, `autogenerated\n`);

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uriToIgnore);
        assert.ok(resource);
        assert.ok(!existsSync(urlIgnoredGlob.fsPath));

        await documentWasShown(
            this.ctx.sandbox,
            urlIgnoredGlob.fsPath,
            [],
            () => commands.executeCommand('fossil.ignore', resource)
        );
        const globIgnore = await fs.readFile(urlIgnoredGlob.fsPath);
        assert.equal(globIgnore.toString('utf-8'), 'autogenerated\n');
        const cwd = workspace.workspaceFolders![0].uri.fsPath as FossilCWD;
        const executable = getExecutable();
        await executable.exec(cwd, [
            'commit',
            '-m',
            'fossil_ignore_new' as FossilCommitMessage,
            '--',
        ]);

        // now append to ignore list
        const uriToIgnore2 = Uri.joinPath(rootUri, 'autogenerated2');
        await fs.writeFile(uriToIgnore2.fsPath, `autogenerated2\n`);
        await repository.updateStatus('Test' as Reason);
        const resource2 = repository.untrackedGroup.getResource(uriToIgnore2);
        assert.ok(resource2);
        await documentWasShown(
            this.ctx.sandbox,
            urlIgnoredGlob.fsPath,
            [],
            () => commands.executeCommand('fossil.ignore', resource2)
        );

        const globIgnore2 = await fs.readFile(urlIgnoredGlob.fsPath);
        assert.equal(
            globIgnore2.toString('utf-8'),
            'autogenerated\nautogenerated2\n'
        );
        await executable.exec(cwd, [
            'commit',
            '-m',
            'fossil_ignore_new_2' as FossilCommitMessage,
            '--',
        ]);
    }).timeout(8000);

    test('Ignore (nothing)', async () => {
        await commands.executeCommand('fossil.ignore');
    });

    test('Open files (nothing)', async () => {
        await commands.executeCommand('fossil.openFiles');
    });

    test('Open files (group)', async () => {
        const repository = getRepository();
        const execStub = getExecStub(this.ctx.sandbox);
        fakeFossilStatus(execStub, `ADDED a\nADDED b\n`);
        await repository.updateStatus('Test' as Reason);
        assertGroups(repository, {
            working: [
                [Uri.joinPath(rootUri, 'a').fsPath, ResourceStatus.ADDED],
                [Uri.joinPath(rootUri, 'b').fsPath, ResourceStatus.ADDED],
            ],
        });

        const testTd: TextDocument = { isUntitled: false } as TextDocument;
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves(testTd);
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand(
            'fossil.openFiles',
            repository.workingGroup
        );
        sinon.assert.calledTwice(otd);
        sinon.assert.calledTwice(std);
    });

    test('Open files', async () => {
        const rootUri = workspace.workspaceFolders![0].uri;
        const uriToOpen = Uri.joinPath(rootUri, 'a file to open.txt');
        await fs.writeFile(uriToOpen.fsPath, `text inside\n`);

        const repository = getRepository();
        await repository.updateStatus('Test' as Reason);
        const resource = repository.untrackedGroup.getResource(uriToOpen);
        assert.ok(resource);

        await documentWasShown(
            this.ctx.sandbox,
            sinon.match({ path: uriToOpen.path }),
            [
                {
                    preserveFocus: true,
                    preview: true,
                    viewColumn: ViewColumn.Active,
                },
            ],
            () => commands.executeCommand('fossil.openFiles', resource)
        );
    }).timeout(6000);

    test('Open resource: nothing', async () => {
        await commands.executeCommand('fossil.openResource');
    }).timeout(100);

    const createTestResource = async (status: string) => {
        const repository = getRepository();
        const uri = Uri.joinPath(rootUri, 'open_resource.txt');
        const execStub = getExecStub(this.ctx.sandbox);
        const statusStub = fakeFossilStatus(
            execStub,
            `${status} open_resource.txt`
        );
        await repository.updateStatus('Test' as Reason);
        sinon.assert.calledOnce(statusStub);
        const resource = repository.workingGroup.getResource(uri);
        assert.ok(resource);
        return [uri, resource] as [Uri, FossilResource];
    };

    const diffCheck = async (status: string, caption: string) => {
        const [uri, resource] = await createTestResource(status);

        const diffCall = this.ctx.sandbox
            .stub(commands, 'executeCommand')
            .callThrough()
            .withArgs('vscode.diff')
            .resolves();

        await commands.executeCommand('fossil.openResource', resource);

        sinon.assert.calledOnceWithExactly(
            diffCall,
            'vscode.diff',
            sinon.match({ path: uri.fsPath }),
            sinon.match({ path: uri.fsPath }),
            `open_resource.txt (${caption})`,
            {
                preserveFocus: true,
                preview: undefined,
                viewColumn: -1,
            }
        );
    };

    test('Open resource (Working Directory)', async () => {
        await diffCheck('EDITED', 'Working Directory');
    });

    test('Open resource (Deleted)', async () => {
        await diffCheck('DELETED', 'Deleted');
    });

    test('Open resource (Missing)', async () => {
        await diffCheck('MISSING', 'Missing');
    });

    test('Open resource (Renamed)', async () => {
        await diffCheck('RENAMED', 'Renamed');
    });

    test('Open resource (Added)', async () => {
        const [uri, resource] = await createTestResource('ADDED');
        const testTd: TextDocument = { isUntitled: false } as TextDocument;
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves(testTd);
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand('fossil.openResource', resource);
        void uri.fsPath; // populate fsPath property this way
        sinon.assert.calledOnceWithExactly(otd, uri as any);
        sinon.assert.calledOnceWithExactly(
            std,
            testTd as any,
            {
                preview: undefined,
                preserveFocus: true,
                viewColumn: ViewColumn.Active,
            } as TextDocumentShowOptions
        );
    });
    test('Open resource (Missing)', async () => {
        const [, resource] = await createTestResource('MISSING');
        const otd = this.ctx.sandbox
            .stub(workspace, 'openTextDocument')
            .resolves();
        const std = this.ctx.sandbox
            .stub(window, 'showTextDocument')
            .resolves();
        await commands.executeCommand('fossil.openResource', resource);
        sinon.assert.notCalled(otd);
        sinon.assert.notCalled(std);
    });

    test('Add current editor uri', async () => {
        const uri = Uri.joinPath(rootUri, 'opened.txt');
        await fs.writeFile(uri.fsPath, 'opened');
        const repository = getRepository();
        // make file available in 'untracked' group
        await repository.updateStatus('Test' as Reason);
        const document = await workspace.openTextDocument(uri);
        await window.showTextDocument(document, { preview: false });

        const addStub = getExecStub(this.ctx.sandbox)
            .withArgs(sinon.match.array.startsWith(['add']))
            .resolves(fakeExecutionResult());
        await commands.executeCommand('fossil.add');
        sinon.assert.calledOnceWithExactly(addStub, [
            'add',
            '--',
            'opened.txt' as RelativePath,
        ]);
        await fs.unlink(uri.fsPath);
    });
}
