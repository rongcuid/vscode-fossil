/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import {
    window,
    QuickPickItem,
    workspace,
    ViewColumn,
    Uri,
    Disposable,
    QuickPickItemKind,
    InputBoxOptions,
} from 'vscode';
import {
    Commit,
    CommitDetails,
    FileStatus,
    FossilPath,
    FossilRoot,
    FossilURI,
    FossilBranch,
    BranchDetails,
    FossilTag,
    FossilCheckin,
    FossilHash,
    FossilSpecialTags,
    FossilUndoCommand,
    FossilCommitMessage,
    FossilUsername,
    FossilPassword,
    StashItem,
    ResourceStatus,
    UserPath,
    RelativePath,
    StashID,
    FossilRemote,
    FossilRemoteName,
    FossilColor,
} from './openedRepository';
import * as humanise from './humanise';
import { Repository, LogEntriesOptions } from './repository';
import typedConfig from './config';
import { localize } from './main';
import {
    ExecFailure,
    FossilArgs,
    FossilCWD,
    FossilProjectDescription,
    FossilProjectName,
    FossilStdOut,
    FossilWikiTitle,
} from './fossilExecutable';
import { ThemeIcon } from 'vscode';
import { QuickInputButton } from 'vscode';

const SHORT_HASH_LENGTH = 12;
const LONG_HASH_LENGTH = SHORT_HASH_LENGTH * 2;
let lastUsedRepoUrl = 'https://fossil-scm.org/home';
let lastUsedNewFossilPath: Uri | undefined;
let lastUsedUser: string | undefined;

export const enum BranchExistsAction {
    None,
    Reopen,
    UpdateTo,
}

export const enum CommitSources {
    File,
    Repo,
}

export interface NewBranchOptions {
    readonly branch: FossilBranch;
    readonly color: FossilColor | '';
    readonly isPrivate: boolean;
}

/**
 * @returns workspaceDir/(default_name + postfix)
 */
function suggestPath(default_name = 'repo_name', postfix = '.fossil'): Uri {
    const folders = workspace.workspaceFolders;
    if (folders?.length) {
        const dir = folders[0].uri;
        return Uri.joinPath(
            dir,
            (path.basename(dir.fsPath) || default_name) + postfix
        );
    }
    return Uri.joinPath(Uri.file(os.homedir()), default_name + postfix);
}

/** ask user for the new .fossil file location */
export async function selectNewFossilPath(
    saveLabel: 'Clone' | 'Create'
): Promise<FossilPath | undefined> {
    const defaultFossilFile = lastUsedNewFossilPath || suggestPath();
    const uri = await window.showSaveDialog({
        defaultUri: defaultFossilFile,
        title: 'Select New Fossil File Location',
        saveLabel: saveLabel,
        filters: {
            'All files': ['*'],
        },
    });
    if (uri) {
        lastUsedNewFossilPath = uri;
    }
    return uri?.fsPath as FossilPath | undefined;
}

/**
 * ask user to open existing .fossil file
 *
 * @returns fossil file uri
 */
export async function selectExistingFossilPath(): Promise<
    FossilPath | undefined
> {
    const defaultFossilFile = suggestPath();
    const uri = await window.showOpenDialog({
        defaultUri: defaultFossilFile,
        openLabel: 'Repository Location',
        filters: {
            'Fossil Files': ['fossil'],
            'All files': ['*'],
        },
        canSelectMany: false,
    });
    if (uri?.length) {
        return uri[0].fsPath as FossilPath;
    }
    return;
}

export function statusCloning(clonePromise: Promise<FossilRoot>): Disposable {
    return window.setStatusBarMessage(
        localize('cloning', 'Cloning fossil repository...'),
        clonePromise
    );
}

export function informNoChangesToCommit(): void {
    window.showInformationMessage(
        localize('no changes', 'There are no changes to commit.')
    );
}

export async function checkActiveMerge(
    repository: Repository
): Promise<boolean> {
    if (repository.fossilStatus?.isMerge) {
        const doit = localize('continue', 'Continue');
        const answer = await window.showWarningMessage(
            localize('outstanding merge', 'Merge is in progress'),
            { modal: true },
            doit
        );
        return answer != doit;
    }
    return false;
}

export async function warnNoRemotes(): Promise<void> {
    await window.showErrorMessage(
        localize(`no remotes`, `Your repository has no remotes configured.`)
    );
}

export function warnResolveConflicts(this: void): Thenable<string | undefined> {
    return window.showWarningMessage(
        localize('conflicts', 'Resolve conflicts before committing.')
    );
}

export async function warnNoUndoOrRedo(
    this: void,
    command: 'undo' | 'redo'
): Promise<void> {
    await window.showWarningMessage(
        localize(`no ${command}`, `Nothing to ${command}.`)
    );
}

export async function errorPromptOpenLog(err: ExecFailure): Promise<boolean> {
    const hint = (err.stderr || err.message || String(err))
        .replace(/^abort: /im, '')
        .split(/[\r\n]/)
        .filter((line: string) => !!line)[0];

    const message = hint
        ? localize('fossil error details', 'Fossil: {0}', hint)
        : localize('fossil error', 'Fossil error');

    const openOutputChannelChoice = localize(
        'open fossil log',
        'Open Fossil Log'
    );
    const choice = await window.showErrorMessage(
        message,
        openOutputChannelChoice
    );
    return choice === openOutputChannelChoice;
}

export async function promptOpenClonedRepo(this: void): Promise<boolean> {
    const open = localize('openrepo', 'Open Repository');
    const result = await window.showInformationMessage(
        localize(
            'proposeopen',
            'Would you like to open the cloned repository?'
        ),
        open
    );
    return result === open;
}

export async function confirmOpenNotEmpty(
    this: void,
    dir: FossilCWD
): Promise<boolean> {
    const open = localize('openrepo', '&&Open Repository');

    const message = localize(
        'proposeforceopen',
        'The directory {0} is not empty.\nOpen repository here anyway?',
        dir
    );
    const result = await window.showWarningMessage(
        message,
        { modal: true },
        open
    );
    return result === open;
}

export async function confirmRename(
    oldPath: RelativePath,
    newPath: RelativePath
): Promise<boolean> {
    const question = localize(
        'rename {0} to {1}',
        '"{0}" was renamed to "{1}" on filesystem. Rename in fossil repository too?',
        oldPath,
        newPath
    );
    const dontShowAgain = localize('neverAgain', "Don't show again");
    const answer = await window.showInformationMessage(
        question,
        { modal: false },
        'Yes',
        'Cancel',
        dontShowAgain
    );
    if (answer === dontShowAgain) {
        await typedConfig.disableRenaming();
    }
    return answer === 'Yes';
}

export async function inputRepoUrl(this: void): Promise<FossilURI | undefined> {
    const url = await window.showInputBox({
        value: lastUsedRepoUrl,
        valueSelection: [lastUsedRepoUrl.indexOf('//') + 2, 99999],
        prompt: localize('repourl', 'Repository URI'),
        ignoreFocusOut: true,
    });
    if (url) {
        lastUsedRepoUrl = url;
        return Uri.parse(url) as FossilURI;
    }
    return undefined;
}

export async function inputPrompt(
    stdout: FossilStdOut,
    args: FossilArgs
): Promise<string | undefined> {
    const title = 'Fossil Request';
    const panel = window.createWebviewPanel(
        'inputPrompt',
        title,
        ViewColumn.One
    );
    function escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        };
        return text.replace(/[&<>"']/g, function (m) {
            return map[m];
        });
    }
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="padding-top:3em">
<pre><b>${args.map(escapeHtml).join(' ')}</b>:
${escapeHtml(stdout)}
</pre></body></html>`;
    const lines = stdout.split('\n');
    const resp = await window.showInputBox({
        prompt: lines[lines.length - 1],
        ignoreFocusOut: true,
    });
    panel.dispose();
    return resp;
}

async function inputCommon<TRet extends string = string>(
    this: void,
    key:
        | 'repourl'
        | 'project name'
        | 'project description'
        | 'technote comment'
        | 'wiki entry'
        | 'commit hash',
    message: string,
    extra: InputBoxOptions = {}
): Promise<TRet | undefined> {
    return window.showInputBox({
        prompt: localize(key, message),
        ignoreFocusOut: true,
        ...extra,
    }) as Thenable<TRet | undefined>;
}

export async function inputProjectName(
    this: void
): Promise<FossilProjectName | undefined> {
    return inputCommon<FossilProjectName>('project name', 'Project Name', {
        placeHolder: 'Leave empty to not set Project Name',
    });
}

export async function inputProjectDescription(
    this: void
): Promise<FossilProjectDescription | undefined> {
    return inputCommon<FossilProjectDescription>(
        'project description',
        'Project Description',
        {
            placeHolder: 'Leave empty to not set Project Description',
        }
    );
}

export async function inputWikiComment(
    this: void,
    what: 'Technote' | 'Wiki'
): Promise<FossilWikiTitle | undefined> {
    switch (what) {
        case 'Technote':
            return inputCommon<FossilWikiTitle>(
                'technote comment',
                'Timeline comment of the technote'
            );
        case 'Wiki':
            return inputCommon<FossilWikiTitle>(
                'wiki entry',
                'Name of the wiki entry'
            );
    }
}

export async function inputPatchCreate(): Promise<UserPath | undefined> {
    const defaultPatchFile = suggestPath('patch', '.fossilpatch');
    const uri = await window.showSaveDialog({
        defaultUri: defaultPatchFile,
        saveLabel: localize('Create', 'Create'),
        title: localize('new binary path', 'Create binary patch'),
    });
    return uri?.fsPath as UserPath | undefined;
}

export async function inputPatchApply(
    this: void
): Promise<UserPath | undefined> {
    const uris = await window.showOpenDialog({
        defaultUri: Uri.file('patch.fossilpatch'),
        canSelectMany: false,
        openLabel: localize('Apply', 'Apply'),
        title: localize('apply binary patch', 'Apply binary patch'),
    });
    if (uris?.length == 1) {
        return uris[0].fsPath as UserPath;
    }
    return undefined;
}

class PathPickItem implements QuickPickItem {
    get label(): string {
        return `$(symbol-file) ${this.path}`;
    }
    constructor(readonly path: RelativePath) {}
}

export async function selectNewFileLocation(
    defaultUri: Uri,
    srcRelativePath: RelativePath,
    paths: RelativePath[]
): Promise<UserPath | RelativePath | undefined> {
    const items = paths.map(res => new PathPickItem(res));
    const userSelect: QuickPickItem = {
        label: localize('Open Dialog', '$(folder-opened) Open Dialog'),
        alwaysShow: true,
    };
    const separator: QuickPickItem = {
        label: 'Extras',
        kind: QuickPickItemKind.Separator,
    };
    const title = localize(
        'New location for {0}',
        'New location for {0}',
        srcRelativePath
    );
    const selection = await window.showQuickPick(
        [userSelect, separator, ...items],
        { title }
    );
    if (selection === userSelect) {
        const uris = await window.showOpenDialog({
            defaultUri,
            canSelectMany: false,
            openLabel: localize(
                'Select as new location',
                'Select as new location'
            ),
            title,
        });
        if (uris?.length == 1) {
            return uris[0].fsPath as UserPath;
        }
        return undefined;
    }
    return (selection as PathPickItem | undefined)?.path;
}

export async function selectFossilRootPath(
    this: void
): Promise<FossilRoot | undefined> {
    const defaultUri = workspace.workspaceFolders
        ? workspace.workspaceFolders[0].uri
        : undefined;
    const uri = await window.showOpenDialog({
        defaultUri: defaultUri,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: localize('root_directory', 'Select Fossil Root Directory'),
    });
    if (uri?.length) {
        return uri[0].fsPath as FossilRoot;
    }
    return;
}

export async function inputCloneUser(
    this: void
): Promise<FossilUsername | undefined> {
    const value = lastUsedUser || typedConfig.username || process.env.USER;
    const user = await window.showInputBox({
        prompt: localize('username', 'Username'),
        placeHolder: 'None',
        ignoreFocusOut: true,
        value,
    });
    lastUsedUser = user;
    return user as FossilUsername | undefined;
}

export async function inputClonePassword(
    this: void
): Promise<FossilPassword | undefined> {
    const auth = await window.showInputBox({
        prompt: localize('user authentication', 'User Authentication'),
        placeHolder: localize('password', 'Password. Leave empty for none'),
        password: true,
        ignoreFocusOut: true,
    });
    return auth as FossilPassword | undefined;
}

export async function warnBranchAlreadyExists(
    name: FossilBranch
): Promise<BranchExistsAction> {
    const updateTo = localize('update', '&&Update');
    const reopen = localize('reopen', '&&Re-open');
    const message = localize(
        'branch already exists',
        "Branch '{0}' already exists. Update or Re-open?",
        name
    );
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        updateTo,
        reopen
    );
    if (choice === reopen) {
        return BranchExistsAction.Reopen;
    } else if (choice === updateTo) {
        return BranchExistsAction.UpdateTo;
    }
    return BranchExistsAction.None;
}

export async function inputNewBranchOptions(
    this: void
): Promise<NewBranchOptions | undefined> {
    const inputBox = window.createInputBox();
    inputBox.ignoreFocusOut = true;
    const colorBtn: QuickInputButton = {
        iconPath: new ThemeIcon('symbol-color'),
        tooltip: 'Set Branch Color',
    };
    const privateBtn: QuickInputButton = {
        iconPath: new ThemeIcon('eye'),
        tooltip: 'Make Branch Private',
    };
    const publicBtn: QuickInputButton = {
        iconPath: new ThemeIcon('eye-closed'),
        tooltip: 'Make Branch public',
    };
    let color: FossilColor | '' = '';
    let curBranch = '';
    const askBranch = () => {
        inputBox.value = curBranch;
        inputBox.placeholder = localize('branch name', 'Branch name');
        inputBox.prompt = localize(
            'provide branch name',
            'Please provide a branch name'
        );
        inputBox.validationMessage = '';
        inputBox.buttons = [colorBtn, privateBtn];
    };
    askBranch();
    const cssColors = (
        'aqua|black|blue|fuchsia|gray|green|lime|' +
        'maroon|navy|olive|orange|purple|red' +
        '|silver|teal|white|yellow|aliceblue' +
        '|antiquewhite|aquamarine|azure|beige' +
        '|bisque|blanchedalmond|blueviolet|brown' +
        '|burlywood|cadetblue|chartreuse|chocolate' +
        '|coral|cornflowerblue|cornsilk|crimson' +
        '|cyan|darkblue|darkcyan|darkgoldenrod' +
        '|darkgray|darkgreen|darkgrey|darkkhaki' +
        '|darkmagenta|darkolivegreen|darkorange' +
        '|darkorchid|darkred|darksalmon|darkseagreen' +
        '|darkslateblue|darkslategray|darkslategrey' +
        '|darkturquoise|darkviolet|deeppink' +
        '|deepskyblue|dimgray|dimgrey|dodgerblue' +
        '|firebrick|floralwhite|forestgreen' +
        '|gainsboro|ghostwhite|gold|goldenrod' +
        '|greenyellow|grey|honeydew|hotpink|indianred' +
        '|indigo|ivory|khaki|lavender|lavenderblush' +
        '|lawngreen|lemonchiffon|lightblue|lightcoral' +
        '|lightcyan|lightgoldenrodyellow|lightgray' +
        '|lightgreen|lightgrey|lightpink|lightsalmon' +
        '|lightseagreen|lightskyblue|lightslategray' +
        '|lightslategrey|lightsteelblue|lightyellow' +
        '|limegreen|linen|magenta|mediumaquamarine' +
        '|mediumblue|mediumorchid|mediumpurple' +
        '|mediumseagreen|mediumslateblue' +
        '|mediumspringgreen|mediumturquoise' +
        '|mediumvioletred|midnightblue|mintcream' +
        '|mistyrose|moccasin|navajowhite|oldlace' +
        '|olivedrab|orangered|orchid|palegoldenrod' +
        '|palegreen|paleturquoise|palevioletred' +
        '|papayawhip|peachpuff|peru|pink|plum' +
        '|powderblue|rebeccapurple|rosybrown' +
        '|royalblue|saddlebrown|salmon|sandybrown' +
        '|seagreen|seashell|sienna|skyblue|slateblue' +
        '|slategray|slategrey|snow|springgreen' +
        '|steelblue|tan|thistle|tomato|transparent' +
        '|turquoise|violet|wheat|whitesmoke' +
        '|yellowgreen'
    ).split('|');
    const isValidColor = (value: string) =>
        !value ||
        /^#[0-9a-f]{6}$/i.test(value) ||
        cssColors.includes(value.toLowerCase());

    const branch = await new Promise<FossilBranch | undefined>(resolve => {
        inputBox.onDidChangeValue(value => {
            inputBox.validationMessage =
                inputBox.buttons.length || isValidColor(value)
                    ? ''
                    : 'color format: #RRGGBB';
        });
        inputBox.onDidAccept(() => {
            if (!inputBox.buttons.length) {
                const value = inputBox.value as FossilColor;
                color = isValidColor(value) ? value : '';
                askBranch();
            } else {
                resolve(inputBox.value as FossilBranch);
            }
        });
        inputBox.onDidHide(() => resolve(undefined));
        inputBox.onDidTriggerButton(btn => {
            switch (btn) {
                case colorBtn:
                    curBranch = inputBox.value;
                    inputBox.value = color;
                    inputBox.prompt = localize(
                        'provide color',
                        'Please color in #RRGGBB format'
                    );
                    inputBox.placeholder = localize(
                        'branch color',
                        'Branch color'
                    );
                    inputBox.buttons = [];
                    break;
                case privateBtn:
                    inputBox.buttons = [colorBtn, publicBtn];
                    break;
                case publicBtn:
                    inputBox.buttons = [colorBtn, privateBtn];
                    break;
            }
        });
        inputBox.show();
    });
    inputBox.dispose();
    if (branch) {
        return {
            branch,
            color,
            isPrivate: inputBox.buttons.includes(publicBtn),
        };
    }
    return;
}

export async function pickBranch(
    branches: BranchDetails[],
    placeHolder: string
): Promise<FossilBranch | undefined> {
    const headChoices = branches.map(head => new BranchItem(head));
    const choice = await window.showQuickPick(headChoices, { placeHolder });
    return choice?.checkin;
}

export async function pickUpdateCheckin(
    refs: [BranchDetails[], FossilTag[]]
): Promise<FossilCheckin | undefined> {
    const branches = refs[0].map(ref => new BranchItem(ref));
    const tags = refs[1].map(ref => new TagItem(ref));
    const picks = [
        new UserInputItem(),
        {
            kind: QuickPickItemKind.Separator,
            label: '',
            run: () => {
                /* separator action */
            },
            description: '',
        } as RunnableQuickPickItem,
        ...branches,
        ...tags,
    ];

    let result: CheckinItem<FossilCheckin> | RunnableQuickPickItem | undefined =
        await window.showQuickPick(picks, {
            placeHolder: 'Select a branch/tag to update to:',
            matchOnDescription: true,
        });
    while (result) {
        if (result instanceof CheckinItem) {
            return result.checkin;
        }
        result = await result.run();
    }
    return undefined;
}

function describeLogEntrySource(kind: CommitSources): string {
    switch (kind) {
        case CommitSources.Repo:
            return localize('repo history', 'Repo history');
        case CommitSources.File:
            return localize('file history', 'File history');
    }
}

function describeCommitOneLine(commit: Commit): string {
    return `#${commit.hash.slice(0, LONG_HASH_LENGTH)} • ${
        commit.author
    }, ${humanise.ageFromNow(commit.date)} • ${commit.message}`;
}

function asBackItem(
    description: string,
    action: RunnableAction
): RunnableQuickPickItem {
    const goBack = localize('go back', 'go back');
    const to = localize('to', 'to');
    return new LiteralRunnableQuickPickItem(
        `$(arrow-left)  ${goBack}`,
        `${to} ${description}`,
        '',
        action
    );
}

export async function presentLogSourcesMenu(
    commands: InteractionAPI
): Promise<void> {
    const entries = await commands.getLogEntries({});
    let result = await pickCommitAsShowCommitDetailsRunnable(
        CommitSources.Repo,
        entries,
        commands
    );
    while (result) {
        result = await result.run();
    }
}

async function pickCommitAsShowCommitDetailsRunnable(
    source: CommitSources,
    entries: Commit[],
    commands: InteractionAPI,
    back?: RunnableQuickPickItem
): Promise<RunnableQuickPickItem | undefined> {
    const backhere = asBackItem(
        describeLogEntrySource(source).toLowerCase(),
        () =>
            pickCommitAsShowCommitDetailsRunnable(
                source,
                entries,
                commands,
                back
            )
    );
    const commitPickedActionFactory = (checkin: FossilCheckin) => async () => {
        const details = await commands.getCommitDetails(checkin);
        return presentCommitDetails(details, backhere, commands);
    };

    const choice = await pickCommit(
        source,
        entries,
        commitPickedActionFactory,
        back
    );
    return choice;
}

/**
 * Present user with a list of Commit[]s
 *
 * @param source represent commit source
 * @param commits the commits
 * @param action what to do when commit is selected
 * @param backItem optional "back" action
 * @returns
 */
export async function pickCommit(
    source: CommitSources,
    commits: Commit[],
    action: (commit: FossilCheckin) => RunnableAction,
    backItem?: RunnableQuickPickItem
): Promise<RunnableQuickPickItem | undefined> {
    const logEntryPickItems: RunnableQuickPickItem[] = commits.map(
        commit => new RunnableTimelineEntryItem(commit, action(commit.hash))
    );
    const current = new LiteralRunnableQuickPickItem(
        '$(tag) Current',
        '',
        'Current checkout',
        action('current')
    );
    logEntryPickItems.unshift(current);
    const placeHolder = describeLogEntrySource(source);
    const pickItems = backItem
        ? [backItem, ...logEntryPickItems]
        : logEntryPickItems;
    const choice = await window.showQuickPick(pickItems, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    return choice;
}

export async function pickCommitToCherrypick(
    logEntries: Commit[]
): Promise<FossilHash | undefined> {
    const logEntryPickItems = logEntries.map(
        entry => new TimelineEntryItem(entry)
    );
    const placeHolder = localize('cherrypick commit', 'Commit to cherrypick');
    const choice = await window.showQuickPick(logEntryPickItems, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return choice?.commit.hash;
}

export async function pickStashItem(
    items: StashItem[],
    operation: 'drop' | 'apply'
): Promise<StashID | undefined> {
    const stashItems = items.map(entry => new StashEntryItem(entry));
    const placeHolder = localize(
        `stash to ${operation}`,
        `Stash to ${operation}`
    );
    const item = await window.showQuickPick(stashItems, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return item?.item.stashId;
}

/**
 * use selected commit in 'fossil.log' command
 */
async function presentCommitDetails(
    details: CommitDetails,
    back: RunnableQuickPickItem,
    commands: InteractionAPI
): Promise<RunnableQuickPickItem | undefined> {
    const placeHolder = describeCommitOneLine(details);
    const diff = (status: FileStatus) =>
        commands.diffToParent(status.path, details.hash);
    const filePickItems = details.files.map(
        f => new FileStatusQuickPickItem(f, () => diff(f))
    );
    const editCommitMessageItem = new LiteralRunnableQuickPickItem(
        '$(edit) Edit commit message',
        '',
        '',
        () => editCommitMessage(details, commands)
    );

    const openChngesItem = new LiteralRunnableQuickPickItem(
        '$(go-to-file) Open all changed files',
        '',
        '',
        async () => {
            for (const status of details.files) {
                await diff(status);
            }
        }
    );

    const changesLabel = {
        label: 'Changes',
        kind: QuickPickItemKind.Separator,
    } as const;

    const items = [
        back,
        editCommitMessageItem,
        openChngesItem,
        changesLabel,
        ...filePickItems,
    ] satisfies (
        | RunnableQuickPickItem
        | { kind: QuickPickItemKind.Separator }
    )[];

    const choice = await window.showQuickPick(items, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder,
    });

    return choice as RunnableQuickPickItem;
}

async function editCommitMessage(
    commitDetails: CommitDetails,
    interactionAPI: InteractionAPI
): Promise<void> {
    const newCommitMessage = await inputCommitMessage(commitDetails.message);
    if (
        newCommitMessage === undefined ||
        newCommitMessage == commitDetails.message
    ) {
        return;
    }
    await interactionAPI.updateCommitMessage(
        commitDetails.hash,
        newCommitMessage
    );
    window.showInformationMessage(
        localize('updated message', 'Commit message was updated.')
    );
}

export async function pickDiffAction(
    commits: Commit[],
    diffAction: (
        to: FossilHash | FossilSpecialTags | undefined
    ) => RunnableAction,
    backAction: RunnableAction
): Promise<void> {
    const items = [
        new LiteralRunnableQuickPickItem(
            '$(circle-outline) Parent',
            '',
            'Show what this commit changed',
            diffAction('parent')
        ),
        new LiteralRunnableQuickPickItem(
            '$(tag) Current',
            'special fossil tag',
            'Show difference with the current checked-out version ',
            diffAction('current')
        ),
        new LiteralRunnableQuickPickItem(
            '$(tag) Tip',
            'special fossil tag',
            'Show difference with the most recent check-in',
            diffAction('tip')
        ),
        new LiteralRunnableQuickPickItem(
            '$(circle-outline) Checkout',
            '',
            'Show differences with checkout',
            diffAction(undefined)
        ),
        new LiteralRunnableQuickPickItem(
            `$(arrow-left)  Go back`,
            '',
            'Select first commit',
            backAction
        ),
        {
            kind: QuickPickItemKind.Separator,
            label: '',
            run: () => {
                /* separator action */
            },
            description: '',
        } as RunnableQuickPickItem,
        ...commits.map(
            commit =>
                new RunnableTimelineEntryItem(commit, diffAction(commit.hash))
        ),
    ];
    const placeHolder = localize('compare with', 'Compare with');
    const choice = await window.showQuickPick(items, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (choice) {
        await choice.run();
    }
}

interface RemoteQuickPickItem extends QuickPickItem {
    readonly uri: FossilURI;
}

export async function pickRemote(
    remotes: FossilRemote[],
    what: 'push to' | 'pull from'
): Promise<FossilRemoteName | undefined> {
    if (remotes.length == 1) {
        return remotes[0].name;
    }
    const picks = remotes.map(
        (remote): RemoteQuickPickItem & { name: FossilRemoteName } => ({
            label: `$(link) ${remote.name}`,
            name: remote.name,
            detail: remote.uri.toString(),
            uri: remote.uri,
        })
    );
    const placeHolder = localize('pick remote', 'Pick a remote to {0}:', what);
    const choice = await window.showQuickPick(picks, {
        placeHolder,
        matchOnDetail: true,
    });
    return choice?.name;
}

export function warnUnsavedChanges(msg: string): void {
    window.showWarningMessage(localize('unsaved changes', `Fossil: ${msg}`));
}

export async function confirmUndoOrRedo(
    command: 'undo' | 'redo',
    command_text: FossilUndoCommand
): Promise<boolean> {
    const confirmText = command[0].toUpperCase() + command.slice(1);
    const message = localize(command, `${confirmText} '{0}'?`, command_text);
    const choice = await window.showInformationMessage(
        message,
        { modal: true },
        confirmText
    );
    return choice === confirmText;
}

export async function inputCommitMessage(
    defaultMessage?: FossilCommitMessage
): Promise<FossilCommitMessage | undefined> {
    return window.showInputBox({
        value: defaultMessage,
        placeHolder: localize('commit message', 'Commit message'),
        prompt: localize(
            'provide commit message',
            'Please provide a commit message'
        ),
        ignoreFocusOut: true,
    }) as Promise<FossilCommitMessage | undefined>;
}

export async function confirmDiscardAllChanges(
    this: void,
    where: string
): Promise<boolean> {
    // `where` can be
    // * "Changes"
    // * "Unresolved Conflicts"
    // * "Changes" and "Unresolved Conflicts"
    const message = localize(
        'confirm discard all',
        'Are you sure you want to discard changes in {0} group?',
        where
    );
    const discard = localize('discard', '&&Discard Changes');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        discard
    );
    return choice === discard;
}

export async function confirmDeleteExtras(this: void): Promise<boolean> {
    const message = localize(
        'confirm delete extras',
        'Are you sure you want to delete untracked and unignored files?'
    );
    const discard = localize('discard', '&&Delete Extras');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        discard
    );
    return choice === discard;
}

export async function confirmDeleteResources(
    this: void,
    paths: string[]
): Promise<boolean> {
    let message: string;
    let yes: string;
    if (paths.length == 1) {
        message = localize(
            'confirm delete',
            'Are you sure you want to DELETE {0}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.',
            path.basename(paths[0])
        );
        yes = localize('delete file', '&&Delete file');
    } else {
        message = localize(
            'confirm delete multiple',
            'Are you sure you want to DELETE {0} files?\nThis is IRREVERSIBLE!\nThese files will be FOREVER LOST if you proceed.',
            paths.length
        );
        yes = localize('delete files', '&&Delete Files');
    }

    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        yes
    );
    return choice === yes;
}

export async function confirmDiscardChanges(
    discardFilesnames: string[],
    addedFilenames: string[]
): Promise<boolean> {
    let addedMessage = '';
    if (addedFilenames.length > 0) {
        if (addedFilenames.length === 1) {
            addedMessage = localize(
                'and forget',
                "\n\n(and forget added file '{0}')",
                path.basename(addedFilenames[0])
            );
        } else {
            addedMessage = localize(
                'and forget multiple',
                '\n\n(and forget {0} other added files)',
                addedFilenames.length
            );
        }
    }

    let message: string;
    if (discardFilesnames.length === 1) {
        message = localize(
            'confirm discard',
            "Are you sure you want to discard changes to '{0}'?{1}",
            path.basename(discardFilesnames[0]),
            addedMessage
        );
    } else {
        const fileList = humanise.formatFilesAsBulletedList(discardFilesnames);
        message = localize(
            'confirm discard multiple',
            'Are you sure you want to discard changes to {0} files?\n\n{1}{2}',
            discardFilesnames.length,
            fileList,
            addedMessage
        );
    }

    const discard = localize('discard', '&&Discard Changes');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        discard
    );
    return choice === discard;
}

export async function confirmDeleteMissingFilesForCommit(
    filenames: string[]
): Promise<boolean> {
    let message: string;
    if (filenames.length === 1) {
        message = localize(
            'confirm delete missing',
            "Did you want to delete '{0}' in this commit?",
            path.basename(filenames[0])
        );
    } else {
        const fileList = humanise.formatFilesAsBulletedList(filenames);
        message = localize(
            'confirm delete missing multiple',
            'Did you want to delete {0} missing files in this commit?\n\n{1}',
            filenames.length,
            fileList
        );
    }

    const deleteOption = localize('delete', '&&Delete');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        deleteOption
    );
    return choice === deleteOption;
}

export async function confirmCommitWorkingGroup(): Promise<boolean> {
    const message = localize(
        'confirm commit working group',
        'There are no staged changes, do you want to commit working changes?\n'
    );
    const respOpt = localize('confirm', 'C&&onfirm');
    const choice = await window.showWarningMessage(
        message,
        { modal: true },
        respOpt
    );
    return choice === respOpt;
}

export async function confirmGitExport(): Promise<boolean> {
    const fromConfig = typedConfig.gitExport;
    if (fromConfig == 'Automatically') {
        return true;
    } else if (fromConfig == 'Never') {
        return false;
    }

    const answer = await window.showInformationMessage(
        'Export repository to git?',
        'Yes',
        'No',
        'Automatically',
        'Never'
    );
    if (answer == 'Yes') {
        return true;
    }
    if (!answer || answer == 'No') {
        return false;
    }
    await typedConfig.setGitExport(answer);
    return answer == 'Automatically';
}

export async function inputWikiType(): Promise<
    'Technote' | 'Wiki' | undefined
> {
    const choice = await window.showQuickPick(['Technote', 'Wiki'], {
        title: 'Create',
    });
    return choice as 'Technote' | 'Wiki' | undefined;
}

abstract class RunnableQuickPickItem implements QuickPickItem {
    abstract get label(): string;
    abstract run(): RunnableReturnType;
}

class TimelineEntryItem extends RunnableQuickPickItem {
    constructor(public commit: Commit) {
        super();
    }
    protected get age(): string {
        return humanise.ageFromNow(this.commit.date);
    }
    get label(): string {
        const hash = this.commit.hash.slice(0, SHORT_HASH_LENGTH);
        return `$(circle-outline) ${hash} • ${this.commit.branch}`;
    }
    get description(): string {
        return `$(person)${this.commit.author} $(calendar) ${this.age}`;
    }
    get detail(): string {
        return this.commit.message;
    }
    run() {
        // do nothing.
    }
}

class StashEntryItem implements QuickPickItem {
    constructor(public item: StashItem) {}
    protected get age(): string {
        return humanise.ageFromNow(this.item.date);
    }
    get label(): string {
        const hash = this.item.hash.slice(0, SHORT_HASH_LENGTH);
        return `$(circle-outline) ${this.item.stashId} • ${hash}`;
    }
    get description(): string {
        return `$(calendar) ${this.age}`;
    }
    get detail(): string {
        return this.item.comment;
    }
}

class RunnableTimelineEntryItem extends TimelineEntryItem {
    constructor(commit: Commit, private action: RunnableAction) {
        super(commit);
    }
    override run() {
        return this.action();
    }
}

class CheckinItem<T extends FossilCheckin> {
    constructor(public readonly checkin: T) {}
}

class BranchItem extends CheckinItem<FossilBranch> implements QuickPickItem {
    get label(): string {
        return `$(git-branch) ${this.checkin}`;
    }
    get description(): string {
        return [
            ...(this.branch.isCurrent ? ['current'] : []),
            ...(this.branch.isPrivate ? ['private'] : []),
        ].join(', ');
    }
    constructor(private branch: BranchDetails) {
        super(branch.name);
    }
}

class TagItem extends CheckinItem<FossilTag> implements QuickPickItem {
    get label(): string {
        return `$(tag) ${this.checkin}`;
    }
}

class FileStatusQuickPickItem extends RunnableQuickPickItem {
    get basename(): string {
        return path.basename(this.status.path);
    }
    get label(): string {
        return `    ${this.icon}  ${this.basename}`;
    }
    get description(): string {
        return path.dirname(this.status.path);
    }
    get icon(): string {
        switch (this.status.status) {
            case ResourceStatus.ADDED:
                return 'Ａ'; //'$(diff-added)';
            case ResourceStatus.MODIFIED:
                return 'Ｍ'; //'$(diff-modified)';
            case ResourceStatus.DELETED:
                return 'Ｒ'; //'$(diff-removed)';
            default:
                return '';
        }
    }

    constructor(
        private readonly status: FileStatus,
        private readonly action: RunnableAction
    ) {
        super();
    }

    async run(): Promise<void> {
        return this.action();
    }
}

/**
 * Simplest possible `RunnableQuickPickItem`
 */
class LiteralRunnableQuickPickItem extends RunnableQuickPickItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly detail: string,
        private _action: RunnableAction
    ) {
        super();
    }

    run(): RunnableReturnType {
        return this._action();
    }
}

class UserInputItem extends RunnableQuickPickItem implements QuickPickItem {
    readonly alwaysShow = true;
    readonly label = '$(pencil) Checkout by hash';

    async run(): Promise<CheckinItem<FossilCheckin> | undefined> {
        const userInput = await inputCommon<FossilCheckin>(
            'commit hash',
            'Enter hash/check-in/tag to update to',
            { placeHolder: 'hash/check-in/tag' }
        );
        if (userInput) {
            return new CheckinItem(userInput);
        }
        return;
    }
}

type RunnableReturnType = Promise<any> | void;
export type RunnableAction = () => RunnableReturnType;
export interface InteractionAPI {
    get currentBranch(): FossilBranch | undefined;
    getCommitDetails(revision: FossilCheckin): Promise<CommitDetails>;
    getLogEntries(options: LogEntriesOptions): Promise<Commit[]>;
    diffToParent(filePath: string, commit: FossilCheckin): Promise<void>;
    updateCommitMessage(
        hash: FossilHash,
        new_commit_message: FossilCommitMessage
    ): Promise<void>;
}
