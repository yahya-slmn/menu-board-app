const form = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');
const submitBtn = document.getElementById('submit-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('user-id').value.trim();
  const password = document.getElementById('password').value;

  errorMsg.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  const result = await window.api.login(id, password);

  if (!result.success) {
    errorMsg.textContent = result.message || 'Sign in failed.';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }
  // On success the main process closes this window and opens the main app window.
});
