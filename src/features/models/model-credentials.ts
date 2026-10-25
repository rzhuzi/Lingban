import { repository } from '@/lib/db/repository';
import { credentialStorage } from '@/lib/secure';

import { createModelConfigurationService } from './model-configuration';

export const modelCredentials = createModelConfigurationService(repository, credentialStorage);
