import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RecoveryTreeProvider, RecoveryTreeItem } from './recoveryTreeProvider';
import { PreviewPanel } from './previewPanel';
import { FileRecovery } from './historyScanner';

let treeProvider: RecoveryTreeProvider;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('✓ Vibe Check is now active!');

    // Create tree provider
    treeProvider = new RecoveryTreeProvider();

    // Register tree view
    const treeView = vscode.window.createTreeView('vibeCheckExplorer', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Check if history exists
    if (!treeProvider.historyExists()) {
        vscode.window.showWarningMessage(
            `Vibe Check: No history found at ${treeProvider.getHistoryPath()}`
        );
    } else {
        // Auto-select first project or current workspace project
        autoSelectProject();
    }

    // Register commands
    const commands = [
        vscode.commands.registerCommand('vibeCheck.refresh', () => {
            treeProvider.refresh();
            vscode.window.showInformationMessage('✓ Vibes refreshed!');
        }),

        vscode.commands.registerCommand('vibeCheck.selectProject', async () => {
            await selectProject();
        }),

        vscode.commands.registerCommand('vibeCheck.preview', async (item: RecoveryTreeItem) => {
            if (item && item.filePath && item.versions) {
                await PreviewPanel.createOrShow(context.extensionUri, treeProvider, item);
            }
        }),

        vscode.commands.registerCommand('vibeCheck.recover', async (item: RecoveryTreeItem) => {
            if (item && item.filePath && item.versions) {
                await recoverFile(item);
            }
        }),

        vscode.commands.registerCommand('vibeCheck.recoverAll', async () => {
            await recoverAllFiles();
        }),

        vscode.commands.registerCommand('vibeCheck.copyContent', (item: RecoveryTreeItem) => {
            if (item && item.versions && item.versions.length > 0) {
                const content = treeProvider.readVersionContent(item.versions[0]);
                vscode.env.clipboard.writeText(content);
                vscode.window.showInformationMessage('✓ Vibe copied to clipboard!');
            }
        }),

        vscode.commands.registerCommand('vibeCheck.showDiff', async (item: RecoveryTreeItem) => {
            if (item && item.versions && item.versions.length >= 2) {
                const newerUri = vscode.Uri.file(item.versions[0].source);
                const olderUri = vscode.Uri.file(item.versions[1].source);
                const fileName = path.basename(item.filePath || 'file');
                
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    olderUri,
                    newerUri,
                    `${fileName}: Compare Vibes`
                );
            } else {
                vscode.window.showInformationMessage('Need at least 2 vibes to compare');
            }
        }),

        // Commands for preview navigation
        vscode.commands.registerCommand('vibeCheck.olderVersion', async () => {
            await PreviewPanel.olderVersion();
        }),

        vscode.commands.registerCommand('vibeCheck.newerVersion', async () => {
            await PreviewPanel.newerVersion();
        }),

        vscode.commands.registerCommand('vibeCheck.copyCurrentContent', () => {
            PreviewPanel.copyContent();
        }),

        vscode.commands.registerCommand('vibeCheck.recoverCurrentFile', async () => {
            const currentFile = PreviewPanel.getCurrentFile();
            if (currentFile) {
                await recoverFile(currentFile, PreviewPanel.getCurrentVersionIndex());
            }
        })
    ];

    // Add all commands to subscriptions
    context.subscriptions.push(treeView, ...commands);
}

/**
 * Auto-select a project based on current workspace
 */
function autoSelectProject(): void {
    const projects = treeProvider.getProjects();
    
    if (projects.length === 0) {
        return;
    }

    // Try to match current workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceName = path.basename(workspaceFolders[0].uri.fsPath).toLowerCase();
        const matchingProject = projects.find(p => p.toLowerCase() === workspaceName);
        
        if (matchingProject) {
            treeProvider.setProject(matchingProject);
            return;
        }
    }

    // Otherwise, show project selector
    selectProject();
}

/**
 * Show project selector
 */
async function selectProject(): Promise<void> {
    const projects = treeProvider.getProjects();
    
    if (projects.length === 0) {
        vscode.window.showWarningMessage('No vibes found in history');
        return;
    }

    // Create quick pick items with file counts
    const items = projects.map(project => {
        const files = treeProvider.getAllFiles();
        treeProvider.setProject(project);
        const fileCount = treeProvider.getAllFiles().size;
        
        return {
            label: project,
            description: `${fileCount} vibes`,
            project: project
        };
    });

    // Reset to show picker
    const currentProject = treeProvider.getCurrentProject();
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a project to check vibes',
        title: '✓ Vibe Check - Select Project'
    });

    if (selected) {
        treeProvider.setProject(selected.project);
        vscode.window.showInformationMessage(`✓ Checking vibes for: ${selected.project}`);
    } else if (currentProject) {
        // Restore previous selection if cancelled
        treeProvider.setProject(currentProject);
    }
}

/**
 * Recover a single file
 */
async function recoverFile(item: RecoveryTreeItem, preselectedVersionIndex?: number): Promise<void> {
    if (!item.filePath || !item.versions || item.versions.length === 0) {
        return;
    }

    // Use preselected version or ask user
    let versionIndex = preselectedVersionIndex ?? 0;
    
    if (preselectedVersionIndex === undefined && item.versions.length > 1) {
        const versionItems = item.versions.map((v, i) => ({
            label: v.timestamp.toLocaleString(),
            description: i === 0 ? '(latest vibe)' : '',
            index: i
        }));

        const selectedVersion = await vscode.window.showQuickPick(versionItems, {
            placeHolder: 'Select vibe to recover',
            title: '✓ Select Version'
        });

        if (!selectedVersion) {
            return;
        }
        versionIndex = selectedVersion.index;
    }

    // Ask for destination
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const destFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Recover Here',
        defaultUri: defaultUri,
        title: '✓ Select folder to recover vibe'
    });

    if (!destFolder || destFolder.length === 0) {
        return;
    }

    const projectName = treeProvider.getCurrentProject() || '';
    const relativePath = FileRecovery.getRelativePath(item.filePath, projectName);
    const destPath = path.join(destFolder[0].fsPath, relativePath);

    try {
        const version = item.versions[versionIndex];
        FileRecovery.restoreFile(version.source, destPath);
        
        const openFile = await vscode.window.showInformationMessage(
            `✓ Vibe recovered to: ${destPath}`,
            'Open File',
            'Open Folder'
        );

        if (openFile === 'Open File') {
            const doc = await vscode.workspace.openTextDocument(destPath);
            await vscode.window.showTextDocument(doc);
        } else if (openFile === 'Open Folder') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destPath));
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to recover vibe: ${error}`);
    }
}

/**
 * Recover all files in current project
 */
async function recoverAllFiles(): Promise<void> {
    const files = treeProvider.getAllFiles();
    
    if (files.size === 0) {
        vscode.window.showWarningMessage('No vibes to recover');
        return;
    }

    // Confirm
    const confirm = await vscode.window.showWarningMessage(
        `Recover all ${files.size} vibes?`,
        { modal: true },
        'Yes',
        'No'
    );

    if (confirm !== 'Yes') {
        return;
    }

    // Ask for destination
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const destFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Recover All Here',
        defaultUri: defaultUri,
        title: '✓ Select folder to recover all vibes'
    });

    if (!destFolder || destFolder.length === 0) {
        return;
    }

    const projectName = treeProvider.getCurrentProject() || '';
    let success = 0;
    let failed = 0;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '✓ Recovering vibes...',
        cancellable: false
    }, async (progress) => {
        const totalFiles = files.size;
        let current = 0;

        for (const [filePath, file] of files) {
            current++;
            progress.report({
                message: `${current}/${totalFiles}: ${path.basename(filePath)}`,
                increment: (1 / totalFiles) * 100
            });

            try {
                const relativePath = FileRecovery.getRelativePath(filePath, projectName);
                const destPath = path.join(destFolder[0].fsPath, relativePath);
                const version = file.versions[0]; // Latest version
                
                FileRecovery.restoreFile(version.source, destPath);
                success++;
            } catch {
                failed++;
            }
        }
    });

    const openFolder = await vscode.window.showInformationMessage(
        `✓ Vibe recovery complete!\n✓ ${success} vibes recovered\n✗ ${failed} failed`,
        'Open Folder'
    );

    if (openFolder === 'Open Folder') {
        await vscode.commands.executeCommand('revealFileInOS', destFolder[0]);
    }
}

/**
 * Extension deactivation
 */
export function deactivate() {
    console.log('Vibe Check deactivated - stay vibey! ✌️');
}
