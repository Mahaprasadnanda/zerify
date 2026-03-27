import { getApps, initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBfv2h_fEn6uAfI_TgjILorLODiBbA5zjQ",
  authDomain: "zerify-a8c25.firebaseapp.com",
  projectId: "zerify-a8c25",
  storageBucket: "zerify-a8c25.firebasestorage.app",
  messagingSenderId: "371236713961",
  appId: "1:371236713961:web:d0cbcbe3cfa82e2fb78778",
  measurementId: "G-HZ2DJZ2YDX",
  databaseURL: "https://zerify-a8c25-default-rtdb.asia-southeast1.firebasedatabase.app",
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const firebaseDb = getDatabase(app);
