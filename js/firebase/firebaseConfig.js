// Firebase project used for multiplayer AND the shared card library.
//
// This config ships with the repo on purpose: every copy of this folder you
// upload to a new GitHub Pages site points at the same project, so cards and
// lobbies are shared across all of them.
//
// Web API keys are not secrets - access is controlled by the database rules in
// database.rules.json and the Authorized domains list, not by hiding this file.
export const firebaseConfig = {
    apiKey: "AIzaSyCStnCR9biL8ckVEZ9h-BZOC58DkxL-mlY",
    authDomain: "my-awesome-project-ae7ec.firebaseapp.com",
    databaseURL: "https://my-awesome-project-ae7ec-default-rtdb.firebaseio.com",
    projectId: "my-awesome-project-ae7ec",
    storageBucket: "my-awesome-project-ae7ec.firebasestorage.app",
    messagingSenderId: "724597369524",
    appId: "1:724597369524:web:fd86eff069b22e43e405e1",
    measurementId: "G-LVGKGZ444L"
};
