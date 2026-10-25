import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AppRepository } from './types';
import { createWebRepository } from './web-repository';

export const repository: AppRepository = createWebRepository(AsyncStorage);
