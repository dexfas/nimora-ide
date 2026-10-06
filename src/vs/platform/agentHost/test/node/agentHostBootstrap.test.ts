/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { NativeEnvironmentService } from '../../../environment/node/environmentService.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { registerAgentHostNetworkServices } from '../../node/agentHostBootstrap.js';

suite('AgentHost network bootstrap', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('reads real native default-profile settings through the registered file provider', async () => {
		const logService = new NullLogService();
		const fileService = disposables.add(new FileService(logService));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.file, provider));
		const environment = new NativeEnvironmentService({ _: [], 'user-data-dir': '/agent-host-bootstrap-user-data' }, { _serviceBrand: undefined, dataFolderName: '.test', version: '1.132.0' } as IProductService);
		assert.strictEqual(environment.userRoamingDataHome.scheme, Schemas.vscodeUserData);
		assert.strictEqual(environment.appSettingsHome.scheme, Schemas.file);
		// A disk provider already has its volume root. Populate that root in the
		// memory fixture too (including the drive segment on Windows).
		await provider.mkdir(URI.from({ scheme: 'inmemory', path: '/' + environment.appSettingsHome.path.split('/').filter(Boolean)[0] }));
		await fileService.createFolder(environment.appSettingsHome);
		await fileService.writeFile(joinPath(environment.appSettingsHome, 'settings.json'), VSBuffer.fromString(JSON.stringify({ 'http.proxy': 'http://proxy.test:3128', 'http.proxySupport': 'override' })));
		const services = new ServiceCollection();
		const store = disposables.add(new DisposableStore());
		await registerAgentHostNetworkServices(services, fileService, environment, logService, store);
		const configuration = services.get(IConfigurationService) as IConfigurationService;
		assert.strictEqual(configuration.getValue('http.proxy'), 'http://proxy.test:3128');
		assert.strictEqual(configuration.getValue('http.proxySupport'), 'override');
	});
});
