/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';

/** Keeps the native startup service contract while routing onboarding to Little's bundled home. */
class LittleOnboardingService implements IOnboardingService {

	declare readonly _serviceBrand: undefined;
	readonly onDidDismiss = Event.None;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) { }

	show(): void {
		this.commandService.executeCommand('little.openWelcome').catch(error => this.logService.error('[Little Code] Opening home failed.', error));
	}
}

registerSingleton(IOnboardingService, LittleOnboardingService, InstantiationType.Delayed);
