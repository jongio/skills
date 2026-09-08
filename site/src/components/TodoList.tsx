import { useEffect, useState } from "preact/hooks";
import { createClient } from "../utils/supabase/client";

type Todo = {
  id: string | number;
  name: string;
};

export default function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const loadTodos = async () => {
      const supabase = createClient();
      const { data, error } = await supabase.from("todos").select("id, name");

      if (error) {
        setError(error.message);
        return;
      }

      setTodos(data);
    };

    void loadTodos();
  }, []);

  if (error) {
    return <p role="alert">Unable to load todos: {error}</p>;
  }

  if (todos.length === 0) {
    return <p class="muted">No todos yet.</p>;
  }

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.name}</li>
      ))}
    </ul>
  );
}
