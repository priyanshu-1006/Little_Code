/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './little.css';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import product from '../../../../platform/product/common/product.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

const agentContainerId = 'workbench.view.extension.little';
const initialLayoutStorageKey = 'little.initialLayout.v1';
const initialWorkspaceStorageKey = 'little.initialWorkspaceLayout.v1';
type LittleNavigationId = 'home' | 'files' | 'search' | 'git' | 'terminal' | 'agent';

// Distribution defaults must exist before BlockRestore prewarms upstream AI.
// Native configuration still gives explicit user and policy settings precedence.
if (product.applicationName === 'little-code') {
	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
		overrides: {
			'chat.disableAIFeatures': true,
			'window.menuBarVisibility': 'compact',
			'window.commandCenter': true,
		},
		source: { id: 'little-code', displayName: 'Little Code' },
	}]);
}

/** Integrates Little's bundled agent with the native editor, Explorer and terminal. */
class LittleWorkbenchContribution extends Disposable {

	static readonly ID = 'workbench.contrib.little';
	private disposed = false;
	private readonly navigationButtons = new Map<LittleNavigationId, HTMLButtonElement>();

	constructor(
		@IProductService private readonly productService: IProductService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IThemeService private readonly themeService: IThemeService,
		@IHoverService private readonly hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._register(toDisposable(() => { this.disposed = true; }));
		if (this.productService.applicationName === 'little-code') {
			mainWindow.document.body.classList.add('little-code');
			this._register(toDisposable(() => mainWindow.document.body.classList.remove('little-code')));
			this.createNavigator();
			this.initializeLayout().catch(error => this.logService.error('[Little Code] Initial layout failed.', error));
		}
	}

	/** Adds real native commands beside the window title without replacing native parts. */
	private createNavigator(): void {
		const titlebar = this.layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART);
		const container = titlebar?.querySelector<HTMLElement>('.titlebar-container');
		const center = container?.querySelector<HTMLElement>('.titlebar-center');
		if (!container || !center) {
			this.logService.warn('[Little Code] Native titlebar is unavailable; commands remain available through the command palette.');
			return;
		}
		const shell = mainWindow.document.createElement('div');
		shell.className = 'little-native-shell';
		const brand = mainWindow.document.createElement('div');
		brand.className = 'little-shell-brand';
		const logo = mainWindow.document.createElement('img');
		logo.className = 'little-shell-logo';
		logo.src = FileAccess.asBrowserUri('vs/workbench/contrib/little/browser/media/little-logo.png').toString(true);
		logo.alt = localize('little.brand', "Little Code");
		logo.draggable = false;
		const name = mainWindow.document.createElement('span');
		name.textContent = localize('little.brand', "Little Code");
		name.setAttribute('aria-hidden', 'true');
		brand.append(logo, name);
		shell.append(brand);
		const navigator = mainWindow.document.createElement('div');
		navigator.className = 'little-shell-navigator';
		navigator.setAttribute('role', 'toolbar');
		navigator.setAttribute('aria-label', localize('little.navigation', "Little Code Navigation"));
		shell.append(navigator);
		const items: { id: LittleNavigationId; label: string; command: string }[] = [
			{ id: 'home', label: localize('little.navigation.home', "Home"), command: 'little.openWelcome' },
			{ id: 'files', label: localize('little.navigation.files', "Files"), command: 'workbench.view.explorer' },
			{ id: 'search', label: localize('little.navigation.search', "Search"), command: 'workbench.view.search' },
			{ id: 'git', label: localize('little.navigation.git', "Git"), command: 'workbench.view.scm' },
			{ id: 'terminal', label: localize('little.navigation.terminal', "Terminal"), command: 'workbench.action.terminal.focus' },
			{ id: 'agent', label: localize('little.navigation.agent', "Agent"), command: 'little.workbench.openAgent' },
		];
		for (const item of items) {
			const button = this.createNavigationButton(item.id, item.label, item.command);
			button.tabIndex = this.navigationButtons.size === 0 ? 0 : -1;
			this.navigationButtons.set(item.id, button);
			navigator.append(button);
		}
		const appearance = this.createNavigationButton('appearance', localize('little.appearance', "Switch Appearance"), 'little.toggleAppearance');
		appearance.classList.add('little-appearance-button');
		appearance.tabIndex = -1;
		navigator.append(appearance);
		const appearanceHover = this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), appearance, ''));
		const updateAppearance = () => {
			const dark = isDark(this.themeService.getColorTheme().type);
			const label = dark ? localize('little.appearance.light', "Switch to Light Mode") : localize('little.appearance.dark', "Switch to Dark Mode");
			appearance.classList.toggle('little-appearance-light', dark);
			appearance.classList.toggle('little-appearance-dark', !dark);
			appearance.setAttribute('aria-label', label);
			appearance.setAttribute('aria-pressed', String(!dark));
			appearanceHover.update(label);
			appearance.querySelector<HTMLElement>('.little-shell-button-label')!.textContent = dark ? localize('little.appearance.light.short', "Light") : localize('little.appearance.dark.short', "Dark");
		};
		updateAppearance();
		this._register(this.themeService.onDidColorThemeChange(updateAppearance));
		container.insertBefore(shell, center);
		container.classList.add('little-has-navigation');
		this._register(toDisposable(() => { shell.remove(); container.classList.remove('little-has-navigation'); }));
		const resizeObserver = new ResizeObserver(() => {
			shell.dataset.density = container.clientWidth < 760 ? 'compact' : container.clientWidth < 1100 ? 'icons' : 'full';
		});
		resizeObserver.observe(container);
		this._register(toDisposable(() => resizeObserver.disconnect()));
		this._register(addDisposableListener(navigator, EventType.FOCUS_IN, event => {
			for (const button of navigator.querySelectorAll<HTMLButtonElement>('button')) {
				button.tabIndex = button === event.target ? 0 : -1;
			}
		}));
		this._register(addDisposableListener(navigator, EventType.KEY_DOWN, event => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
				return;
			}
			const buttons = [...navigator.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
			const current = buttons.findIndex(button => button === mainWindow.document.activeElement);
			if (current < 0 || buttons.length === 0) {
				return;
			}
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
			event.preventDefault();
			event.stopPropagation();
			buttons[next].focus();
		}));
		this._register(addDisposableListener(this.layoutService.getContainer(mainWindow), EventType.FOCUS_IN, () => this.updateNavigator()));
		this._register(this.editorService.onDidActiveEditorChange(() => this.updateNavigator()));
		this._register(this.viewsService.onDidChangeFocusedView(() => this.updateNavigator()));
		this._register(this.viewsService.onDidChangeViewVisibility(() => this.updateNavigator()));
		this._register(this.viewsService.onDidChangeViewContainerVisibility(() => this.updateNavigator()));
		this._register(this.layoutService.onDidChangePartVisibility(() => this.updateNavigator()));
		this.updateNavigator();
	}

	/** Leaves command execution, view activation and terminal creation to native services. */
	private createNavigationButton(id: string, label: string, command: string): HTMLButtonElement {
		const button = mainWindow.document.createElement('button');
		button.type = 'button';
		button.className = `little-shell-button little-navigation-${id}`;
		button.dataset.littleNavigation = id;
		button.setAttribute('aria-label', label);
		const icon = mainWindow.document.createElement('span');
		icon.className = `little-shell-icon little-shell-icon-${id}`;
		icon.setAttribute('aria-hidden', 'true');
		const text = mainWindow.document.createElement('span');
		text.className = 'little-shell-button-label';
		text.textContent = label;
		button.append(icon, text);
		if (id !== 'appearance') {
			this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, label));
		}
		this._register(addDisposableListener(button, EventType.CLICK, async () => {
			try {
				await this.commandService.executeCommand(command);
				if (!this.disposed) {
					this.updateNavigator();
				}
			} catch (error) {
				this.logService.error('[Little Code] Native navigation command failed.', error);
				this.notificationService.error(localize('little.navigation.failed', "Little Code Could Not Open This View. Try Again."));
			}
		}));
		return button;
	}

	/** Highlights only a real visible/focused native surface; it never invents activity. */
	private updateNavigator(): void {
		const home = this.editorService.activeEditor instanceof WebviewInput && this.editorService.activeEditor.viewType === 'mainThreadWebview-little.welcome';
		const visible = new Set<LittleNavigationId>();
		if (home) { visible.add('home'); }
		if (this.viewsService.isViewContainerVisible('workbench.view.explorer')) { visible.add('files'); }
		if (this.viewsService.isViewContainerVisible('workbench.view.search')) { visible.add('search'); }
		if (this.viewsService.isViewContainerVisible('workbench.view.scm')) { visible.add('git'); }
		if (this.viewsService.isViewVisible('terminal')) { visible.add('terminal'); }
		if (this.viewsService.isViewVisible('little.agent')) { visible.add('agent'); }
		let current: LittleNavigationId | undefined;
		if (this.layoutService.hasFocus(Parts.AUXILIARYBAR_PART) && visible.has('agent')) {
			current = 'agent';
		} else if (this.layoutService.hasFocus(Parts.PANEL_PART) && visible.has('terminal')) {
			current = 'terminal';
		} else if (this.layoutService.hasFocus(Parts.SIDEBAR_PART)) {
			current = (['files', 'search', 'git'] as const).find(id => visible.has(id));
		} else if (home) {
			current = 'home';
		}
		for (const [id, button] of this.navigationButtons) {
			button.classList.toggle('is-open', visible.has(id));
			button.classList.toggle('is-current', current === id);
			if (current === id) { button.setAttribute('aria-current', 'true'); }
			else { button.removeAttribute('aria-current'); }
		}
	}

	/** Uses the view service instead of changing another feature's private storage. */
	private async initializeLayout(): Promise<void> {
		await this.extensionService.whenInstalledExtensionsRegistered();
		if (this.disposed || this.storageService.getBoolean(initialWorkspaceStorageKey, StorageScope.WORKSPACE, false)) {
			return;
		}
		const container = this.viewDescriptorService.getViewContainerById(agentContainerId);
		if (!container) {
			this.logService.warn('[Little Code] The bundled Little Agent view is not registered.');
			return;
		}
		const profileInitialized = this.storageService.getBoolean(initialLayoutStorageKey, StorageScope.PROFILE, false);
		if (!profileInitialized && this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, 0, 'little-first-run');
		}
		if (!profileInitialized) {
			this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			const currentWidth = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
			if (currentWidth < 360) {
				this.layoutService.resizePart(Parts.AUXILIARYBAR_PART, 360 - currentWidth, 0);
			}
		}
		await this.viewsService.openViewContainer(agentContainerId, false);
		if (!this.disposed) {
			this.storageService.store(initialLayoutStorageKey, true, StorageScope.PROFILE, StorageTarget.USER);
			this.storageService.store(initialWorkspaceStorageKey, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}
}

registerWorkbenchContribution2(LittleWorkbenchContribution.ID, LittleWorkbenchContribution, WorkbenchPhase.AfterRestored);

registerAction2(class OpenLittleAgentAction extends Action2 {
	constructor() {
		super({
			id: 'little.workbench.openAgent',
			title: localize2('little.openAgent', "Little Code: Focus Agent"),
			icon: Codicon.sparkle,
			f1: false,
			menu: { id: MenuId.CommandCenter, order: 102 },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView('little.agent', true);
	}
});

registerAction2(class OpenLittleHomeAction extends Action2 {
	constructor() {
		super({
			id: 'little.workbench.openHome',
			title: localize2('little.openHome', "Little Code: Open Home"),
			icon: Codicon.home,
			f1: false,
			menu: { id: MenuId.CommandCenter, order: 100 },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('little.openWelcome');
	}
});
