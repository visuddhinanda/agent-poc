// ⚠️ polyfill 导入顺序是强制的（CopilotKit React Native 官方文档要求）：
// 1. 安全随机源必须是第一行（crypto.getRandomValues 谁先装谁生效）
// 2. CopilotKit polyfill barrel 必须在任何 CopilotKit 导入之前
import 'react-native-get-random-values';
import '@copilotkit/react-native/polyfills';

import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
