import { registerRootComponent } from 'expo';

// Background tasks must be defined in the global scope before the app mounts.
import './src/services/backgroundTasks';
import App from './src/App';

registerRootComponent(App);
